import "pdfjs-dist/build/pdf.worker.mjs";
import { getDocument, PDFDocumentProxy } from "pdfjs-dist";
import pdfUrl from "url:./assets/slides.pdf";

const WEBSOCKET_ENDPOINT = "ws://localhost:8000/ws";
let currentPage: RPCMessage = {
  title: "Introduction",
  page: 1,
};

const canvas = document.getElementById("slide") as HTMLCanvasElement;
const canvasContainer = canvas.parentElement as HTMLDivElement;
const slideTitle = document.getElementById("title") as HTMLHeadingElement;
let isRendering = false;
let nextRender: number | null = null;

async function initializePdf() {
  const document = await getDocument(pdfUrl).promise;
  return document;
}

async function renderPage(document: PDFDocumentProxy) {
  slideTitle.innerText = currentPage.title;

  const page = await document.getPage(currentPage.page);
  const scale =
    canvasContainer.clientWidth / page.getViewport({ scale: 1 }).width;
  var viewport = page.getViewport({ scale: scale });
  // Support HiDPI-screens.
  var outputScale = window.devicePixelRatio || 1;

  var context = canvas.getContext("2d") as CanvasRenderingContext2D;
  canvas.height = viewport.height * outputScale;
  canvas.width = viewport.width * outputScale;
  context.scale(outputScale, outputScale);

  let renderContext = {
    canvasContext: context,
    viewport: viewport,
  };

  isRendering = true;
  await page.render(renderContext).promise;
  isRendering = false;

  if (nextRender) {
    nextRender = null;
    await renderPage(document);
  }
}

function queueRender(document: PDFDocumentProxy) {
  if (isRendering) {
    nextRender = currentPage.page;
    return;
  } else {
    renderPage(document);
  }
}

interface RPCMessage {
  title: string;
  page: number;
}

function watchChanges(document: PDFDocumentProxy) {
  const ws = new WebSocket(WEBSOCKET_ENDPOINT);
  slideTitle.textContent = "Connecting to server...";

  ws.onmessage = async (event) => {
    const data: RPCMessage = JSON.parse(event.data);
    if (data.page && data.title) {
      currentPage = data;
      queueRender(document);
    }
  };

  ws.onclose = () => {
    setTimeout(() => {
      watchChanges(document);
    }, 1000);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error: ", error);
    slideTitle.textContent = "Error connecting to server, refresh?";
  };
}

export async function startPdf() {
  const document = await initializePdf();
  addEventListener("resize", () => queueRender(document));
  queueRender(document);
  watchChanges(document);
}
