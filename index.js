import { createServer } from "node:http";
import puppeteer from "puppeteer";
import { createWorker } from "tesseract.js";
import chalk from "chalk";
import { WebClient } from "@slack/web-api";

const { red, green, yellow } = chalk;

const slackToken = "";

const slackChannelId = "C09DF42PWQY"; // 메시지를 보낼 채널 ID (예: #alerts 채널 ID)

const slackClient = new WebClient(slackToken);

// OCR 워커를 전역으로 관리하여 재사용
let globalOcrWorker = null;

let isRunning = false;

async function initOcrWorker() {
  if (!globalOcrWorker) {
    globalOcrWorker = await createWorker("kor");
  }
  return globalOcrWorker;
}

async function terminateOcrWorker() {
  if (globalOcrWorker) {
    await globalOcrWorker.terminate();
    globalOcrWorker = null;
  }
}

async function sendSlackMessage(screenshotBuffer) {
  try {
    const result = await slackClient.files.uploadV2({
      channels: slackChannelId,
      initial_comment: "로컬 파일이 업로드되었습니다.",
      file: screenshotBuffer,
      title: "image.png",
    });

    console.log("파일이 성공적으로 업로드되었습니다. ID:", result.file.id);

    // 업로드된 파일을 메시지에 첨부하는 경우
    await slackClient.chat.postMessage({
      channel: slackChannelId,
      text: "방금 업로드된 파일입니다.",
      blocks: [
        {
          type: "image",
          image_url: result.file.url_private, // 업로드된 파일의 URL 사용
          alt_text: "업로드된 이미지",
        },
      ],
    });
  } catch (error) {
    console.error("파일 업로드 실패:", error);
  }
}

// OCR로 이미지에서 텍스트를 추출하는 함수
async function getTextFromOcr(screenshotBuffer, matcher) {
  try {
    const worker = await initOcrWorker();
    const ret = await worker.recognize(screenshotBuffer);
    const text = ret.data.text.replace(/\s+/g, " ").trim();

    if (text) {
      const matchText = text.match(matcher);

      if (matchText) {
        return matchText[matchText.length - 1];
      }
    }

    // console.log(ret.data.text);
    return null;
  } catch (e) {
    console.error(`      OCR 처리 중 오류 발생: ${e.message}`);
    return null;
  }
}

// 엘리먼트에서 텍스트 가격 정보를 추출하는 함수
async function getTextFromElement(page, selector) {
  try {
    const optionText = await page.$$eval(
      `#option-select .${selector}`,
      (elements) => elements.map((el) => el.textContent.trim())
    );

    if (optionText.length === 0) {
      const text = await page.$$eval(`#${selector} span`, (elements) =>
        elements.map((el) => el.textContent.trim()).join("")
      );

      return [text];
    } else {
      return optionText;
    }
  } catch (e) {
    console.error(`      엘리먼트에서 정보 추출 중 오류 발생: ${e.message}`);
    return null;
  }
}

// 기획전 상세 페이지를 처리하는 함수
async function processCampaignPage(page) {
  try {
    await page.waitForResponse(
      (response) =>
        (response.url().indexOf("/m/mtn/planshop/detail") >= 0 ||
          response.url().indexOf("/m/planshop/getPlanShopDetail.do") >= 0) &&
        response.status() === 200,
      { timeout: 10000 }
    );

    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 }); // 페이지 로딩 완료 대기

    // 기획전 상세 페이지 URL에서 기획전 번호 추출
    const campaignId =
      page.url().indexOf("/m/mtn/planshop/detail/") >= 0
        ? page
            .url()
            .slice(
              "https://m.oliveyoung.co.kr/m/mtn/planshop/detail/".length,
              page.url().indexOf("?")
            )
        : page
            .url()
            .slice(
              page.url().indexOf("dispCatNo=") + "dispCatNo=".length,
              page.url().indexOf("&")
            );

    console.log(`    기획전 번호: ${campaignId}`);

    // 'goods' 클래스를 가진 모든 a 태그를 찾습니다.
    let goodsLinks = await page.$$("a.goods");

    if (goodsLinks.length === 0) {
      console.log(
        "    기획전 상세에 'goods' 클래스를 가진 a 태그가 없습니다. 다음 기획전으로 이동합니다."
      );
      return;
    }

    for (let i = 0; i < goodsLinks.length; i++) {
      // DOM 요소 재할당으로 detached 에러 방지
      goodsLinks = await page.$$("a.goods");
      if (i >= goodsLinks.length) break;

      const goodsLink = goodsLinks[i];

      // 요소가 DOM에 연결되어 있는지 확인
      const isConnected = await goodsLink.evaluate((el) => el.isConnected);
      if (!isConnected) {
        console.log(
          `      상품 ${i + 1}: DOM에서 분리된 요소 감지, 재할당 시도`
        );
        goodsLinks = await page.$$("a.goods");
        if (i >= goodsLinks.length) break;
        continue;
      }

      console.log(
        `    기획전 상세 이미지의 상품 가격과 상품 상세 가격 확인 중 (${
          i + 1
        }/${goodsLinks.length})`
      );

      try {
        // 스크린샷 이미지를 가릴수 있는 플로팅 버튼과 탭바 숨김 처리
        await page.addStyleTag({
          content: "#fixBtn, #tab-bar-wrapper { display: none; }",
        });

        await page.evaluate(() => {
          const videos = document.querySelectorAll("video");
          videos.forEach((video) => video.pause());
        });

        const screenshotBuffer = await goodsLink.screenshot({
          captureBeyondViewport: false,
        });

        // OCR로 가격 정보 추출
        const matcherPrice = /\d{1,3}(,\d{3})*\s*원/g; // '숫자, 콤마, 원'으로 이루어진 패턴을 찾아 가격 추출
        const ocrPrice = await getTextFromOcr(screenshotBuffer, matcherPrice);

        // OCR로 할인율 정보 추출
        const matcherDiscountRate = /\d+%/g;
        const ocrDiscountRate = await getTextFromOcr(
          screenshotBuffer,
          matcherDiscountRate
        );

        // 해당 a 태그 클릭하여 상품 상세 페이지로 이동
        await Promise.all([
          goodsLink.click(),
          page
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: 10000,
            })
            .catch(() => {}),
        ]);

        // 상품 상세 페이지로 정상 이동 하는지 확인
        if (page.url().indexOf("/m/goods/getGoodsDetail.do") < 0) {
          console.log(`      상품 상세 이동 실패. 다음 상품으로 이동합니다.`);
          continue;
        } else {
          // console.log(`      OCR 이미지: ${path}`);
          console.log(`      상품 상세 URL: ${page.url()}`);
        }

        // 상품 상세 페이지의 가격 정보 확인
        const detailPagePrice = await getTextFromElement(page, "price");

        if (ocrPrice !== null && detailPagePrice !== null) {
          if (detailPagePrice.indexOf(ocrPrice) >= 0) {
            console.log(
              `      가격 일치 여부: ${green(
                `${
                  detailPagePrice.length > 1 ? "옵션 가격 " : ""
                }일치 (${ocrPrice})`
              )}`
            );
          } else {
            console.log(
              `      가격 일치 여부: ${red(
                `불일치 (OCR: ${ocrPrice}, 상품 상세: ${detailPagePrice})`
              )}`
            );
            // sendSlackMessage(screenshotBuffer, text);
          }
        } else {
          console.log(
            `      가격 일치 여부: ${yellow(
              `확인 실패 (${
                ocrPrice === null
                  ? "OCR 가격 인식 실패"
                  : `OCR: ${ocrPrice}, 상품 상세: ${detailPagePrice}`
              })`
            )}`
          );
        }

        // 일반적으로 할인율과 최종가를 함께 나타내므로 OCR의 할인율과 가격을 함께 조건으로 확인
        if (ocrDiscountRate !== null && ocrPrice !== null) {
          const detailPageDiscountRate = await getTextFromElement(page, "rate");

          if (
            detailPageDiscountRate &&
            detailPageDiscountRate.indexOf(ocrDiscountRate) >= 0
          ) {
            console.log(
              `      할인율 일치 여부: ${green(
                `${
                  detailPageDiscountRate.length > 1 ? "옵션 할인율 " : ""
                }일치 (${ocrDiscountRate})`
              )}`
            );
          } else {
            console.log(
              `      할인율 일치 여부: ${red(
                `불일치 (OCR: ${ocrDiscountRate}, 상품 상세: ${detailPageDiscountRate})`
              )}`
            );
            // sendSlackMessage(screenshotBuffer, text);
          }
        }

        // 뒤로가기하여 기획전 상세 페이지로 돌아오기
        await Promise.all([
          page.goBack(),
          page
            .waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 })
            .catch(() => {}), // 페이지 로딩 완료 대기
        ]);
        // console.log("      기획전 상세 페이지로 돌아옴.");

        // DOM이 변경되었을 수 있으므로 goodsLinks를 다시 찾아옴
        await page
          .waitForSelector("a.goods", { timeout: 10000 })
          .catch(() => null);

        // 페이지 로딩 완료 후 잠시 대기
        await new Promise((resolve) => setTimeout(resolve, 500));

        goodsLinks = await page.$$("a.goods"); // 재할당

        if (goodsLinks.length === 0) {
          // 뒤로가기 후 요소가 사라진 경우 (매우 드물겠지만 방어 코드)
          console.log(
            "  ERROR: 뒤로가기 후 상품 목록을 찾을 수 없습니다. 다음 기획전으로 이동합니다."
          );
          break; // 현재 기획전 처리 중단
        }
      } catch (e) {
        console.error(`      상품 (${i + 1}) 확인 중 오류 발생: ${e.message}`);

        // 오류 발생 시에도 다음 상품으로 진행할 수 있도록 뒤로가기 시도 후 다음 루프
        await Promise.all([
          page.goBack().catch(() => {}), // 실패해도 무시
          page
            .waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 })
            .catch(() => {}),
        ]);

        // 에러 발생 후 DOM 안정화 대기
        await new Promise((resolve) => setTimeout(resolve, 500));
        goodsLinks = await page.$$("a.goods"); // 재할당
        continue;
      }
    }
  } catch (e) {
    console.error(`    기획전 상세 페이지 처리 중 오류 발생: ${e.message}`);
  }
}

async function getCampaignElement(page, index) {
  const scrollContainer = await page.$("#main-inner-swiper-planshop");

  // 스크롤 컨테이너가 DOM에 연결되어 있는지 확인
  const isScrollContainerConnected = await scrollContainer.evaluate(
    (el) => el.isConnected
  );
  if (!isScrollContainerConnected) {
    console.log("스크롤 컨테이너가 DOM에서 분리됨, 재할당 시도");
    const newScrollContainer = await page.$("#main-inner-swiper-planshop");
    if (!newScrollContainer) return null;
  }

  const campaignElement = await scrollContainer.$(
    `[data-virtuoso-scroller] [data-index="${index}"]`
  );

  if (!campaignElement) {
    // 스크롤 높이를 조정하여 다음 기획전 로드
    await scrollContainer.evaluate((node) => {
      node.scrollTop = node.scrollTop + 357;
    });

    // 새로운 콘텐츠 로딩 대기
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 재귀 호출로 다음 아이템 스크롤 시도
    return getCampaignElement(page, index);
  } else {
    return campaignElement;
  }
}

async function run() {
  const browser = await puppeteer.launch({ headless: true }); // 개발 시 headless: false로 설정하여 시각적으로 확인
  const page = await browser.newPage();

  // 성능 최적화 설정
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const resourceType = req.resourceType();
    if (["font", "media"].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // 아이폰 User-Agent 설정 및 뷰포트 설정
  const iphoneUserAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  await page.setUserAgent(iphoneUserAgent);
  await page.setViewport({ width: 440, height: 956 });

  const baseUrl = "https://m.oliveyoung.co.kr/m/mtn?menu=planshop";
  await page.goto(baseUrl, { waitUntil: "networkidle0" }); // 네트워크 유휴 상태까지 대기
  // console.log(`'${baseUrl}' 페이지 접근 완료 (User-Agent: iPhone)`);

  let paddingBottom = 1;
  let currentDataIndex = 0;

  // TODO: paddingBottom과 마지막 기획전 번호 함께 확인
  while (paddingBottom !== 0) {
    console.log(`\n현재 data-index=${currentDataIndex} 기획전 확인 중...`);

    const scrollContainer = await page.$("#main-inner-swiper-planshop");

    await scrollContainer.evaluate((node) => {
      node.scrollTop = 0;
    });

    await page.waitForFunction(
      `document.getElementById("main-inner-swiper-planshop").scrollTop === 0`
    );

    const campaignElement = await getCampaignElement(page, currentDataIndex);

    if (!campaignElement) {
      console.log(
        `  data-index=${currentDataIndex}에 해당하는 기획전 요소를 찾을 수 없습니다. 다음 기획전으로 이동합니다.`
      );
      currentDataIndex++;
      continue;
    }

    // 기획전 요소가 DOM에 연결되어 있는지 확인
    const isCampaignConnected = await campaignElement.evaluate(
      (el) => el.isConnected
    );
    if (!isCampaignConnected) {
      console.log(
        `  data-index=${currentDataIndex} 기획전 요소가 DOM에서 분리됨. 다음 기획전으로 이동합니다.`
      );
      currentDataIndex++;
      continue;
    }

    const campaignLinkElement = await campaignElement.$(
      '[class*="PlanshopMainItemProduct"] a:first-of-type'
    );

    if (!campaignLinkElement) {
      console.log(
        `  data-index=${currentDataIndex}에 해당하는 기획전이 없습니다. 다음 기획전으로 이동합니다.`
      );
      currentDataIndex++;
      continue;
    }

    const campaignGoodsElement = await campaignElement.$$(
      '[class*="ProductList"] > [class*="ProductItem"]'
    );

    console.log(`  배너 하단 상품 개수: ${campaignGoodsElement.length}`);

    // 스크롤 후 paddingBottom 값 변경 대기
    await new Promise((page) => setTimeout(page, 1000));

    const virtuosoList = await page.$('[data-testid="virtuoso-item-list"]');
    if (virtuosoList) {
      const isVirtuosoConnected = await virtuosoList.evaluate(
        (el) => el.isConnected
      );
      if (isVirtuosoConnected) {
        paddingBottom = await virtuosoList.evaluate((node) => {
          const style = window.getComputedStyle(node);
          return parseInt(style.paddingBottom, 10);
        });
      } else {
        console.log("가상화 리스트 요소가 DOM에서 분리됨");
        paddingBottom = 0; // 루프 종료
      }
    } else {
      paddingBottom = 0; // 루프 종료
    }

    // console.log(`  클릭: data-index="${currentDataIndex}" 기획전 링크`);

    // 클릭 전 링크 요소 유효성 재확인
    const isLinkConnected = await campaignLinkElement.evaluate(
      (el) => el.isConnected
    );
    if (!isLinkConnected) {
      console.log(
        `  기획전 링크가 DOM에서 분리됨. 다음 기획전으로 이동합니다.`
      );
      currentDataIndex++;
      continue;
    }

    await campaignLinkElement.click();
    await processCampaignPage(page); // 기획전 상세 페이지 처리 함수 호출

    // 기획전 상세 페이지에서 작업 후 목록 페이지로 돌아가기
    const currentUrl = page.url();
    if (!currentUrl.includes(baseUrl)) {
      await page.goto(baseUrl, { waitUntil: "networkidle0" });
    }

    currentDataIndex++; // 다음 기획전 인덱스로 이동
  }

  await terminateOcrWorker();
  await browser.close();
  console.log("모든 기획전을 확인했습니다. 작업을 종료합니다.");
  isRunning = false;
}

const server = createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = parsedUrl.pathname;

  if (method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello, World!");
  } else if (method === "GET" && pathname === "/run") {
    if (!isRunning) {
      isRunning = true;
      run().catch(console.error);
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("run");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

const PORT = 4000;

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
