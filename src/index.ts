import { Player } from "./player";
import { startPdf } from "./pdf";

// This is so ghetto but I'm too lazy to improve it right now
const vidRef = document.getElementById("vid") as HTMLVideoElement;
const startRef = document.getElementById("start") as HTMLButtonElement;
const liveRef = document.getElementById("live") as HTMLButtonElement;
const resolutionsRef = document.getElementById(
  "resolutions"
) as HTMLSelectElement;
const continueStreamingRef = document.getElementById("continue_streaming");
const categoryRef = document.getElementById("category") as HTMLSelectElement;
const params = new URLSearchParams(window.location.search);

// fill resolutions combobox
Object.keys(window.config.resolutions).forEach((key) => {
  resolutionsRef.options[resolutionsRef.options.length] = new Option(
    window.config.resolutions[key],
    key
  );
});

const player = new Player({
  url: params.get("url") || window.config.serverURL,
  vid: vidRef,
  resolutions: resolutionsRef,
  continueStreamingRef: continueStreamingRef,
  categoryRef: categoryRef,
  activeBWAsset: window.config.activeBWAsset,
  activeBWTestInterval: window.config.activeBWTestInterval,
  autioStart: window.config.autoStart || true,
  logger: console.log,
});

// expose player
window.player = player;
startRef.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!player.started) {
    await player.start();
    if (player.started) {
      document
        .querySelectorAll("#controls :disabled")
        .forEach((e) => e.removeAttribute("disabled"));
      startRef.innerText = "Stop";
    } else {
      alert("Error occurred in starting!");
    }
  } else {
    player.stop();
  }
});

liveRef.addEventListener("click", (e) => {
  e.preventDefault();
  player.goLive();
});

function playFunc(e: Event) {
  // Only fire once to restore pause/play functionality
  vidRef.removeEventListener("play", playFunc);
}

vidRef.addEventListener("play", playFunc);
vidRef.volume = 0.5;

startPdf();
