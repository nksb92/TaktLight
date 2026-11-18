import { useEffect, useRef } from "react";
import { useTaktStore } from "../store/useTaktStore";
import { AGE_COLORS, AGE_FONTS } from "../styles/theme";

const BUCKET_COUNT = 25;
const TARGET_US = 22727.0;
const HALF_SPAN_US = 250.0;

export function buildHistogramBins(samples: number[]): {
  counts: number[];
  maxCount: number;
  minUs: number;
  maxUs: number;
} {
  const minUs = TARGET_US - HALF_SPAN_US;
  const maxUs = TARGET_US + HALF_SPAN_US;
  const span = maxUs - minUs;
  const counts = new Array<number>(BUCKET_COUNT).fill(0);

  for (const sample of samples) {
    const norm = Math.max(0, Math.min(0.999999, (sample - minUs) / span));
    const idx = Math.floor(norm * BUCKET_COUNT);
    counts[idx] += 1;
  }

  const maxCount = Math.max(1, ...counts);
  return { counts, maxCount, minUs, maxUs };
}

export function JitterHistogram() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const telemetry = useTaktStore((s) => s.telemetry);
  const jitterSamplesUs = useTaktStore((s) => s.jitterSamplesUs);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const padLeft = 40;
    const padRight = 16;
    const padTop = 14;
    const padBottom = 26;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = AGE_COLORS.PITCH;
    ctx.fillRect(0, 0, width, height);

    const { counts, maxCount } = buildHistogramBins(jitterSamplesUs);

    // Horizontal grid lines
    ctx.strokeStyle = AGE_COLORS.STEEL;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Bars
    const barSlot = plotW / BUCKET_COUNT;
    const barGap = 2;
    const barW = Math.max(2, barSlot - barGap);
    const centerBucket = Math.floor(BUCKET_COUNT / 2);

    counts.forEach((count, idx) => {
      const ratio = count / maxCount;
      const barH = Math.max(count > 0 ? 3 : 0, ratio * plotH);
      const x = padLeft + idx * barSlot + barGap / 2;
      const y = padTop + plotH - barH;
      const distFromCenter = Math.abs(idx - centerBucket);

      if (distFromCenter <= 2) {
        ctx.fillStyle = AGE_COLORS.PINE;
      } else if (distFromCenter <= 6) {
        ctx.fillStyle = AGE_COLORS.COBALT;
      } else {
        ctx.fillStyle = AGE_COLORS.EMBER;
      }
      ctx.fillRect(x, y, barW, barH);
    });

    // Target 22,727 us center line
    const centerX = padLeft + plotW / 2;
    ctx.strokeStyle = AGE_COLORS.MIST;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centerX, padTop);
    ctx.lineTo(centerX, padTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Axis labels
    ctx.fillStyle = AGE_COLORS.FOG;
    ctx.font = `10px ${AGE_FONTS.CODE}`;
    ctx.textAlign = "left";
    ctx.fillText("22.48 ms", padLeft, height - 8);
    ctx.textAlign = "center";
    ctx.fillStyle = AGE_COLORS.MIST;
    ctx.fillText("22.73 ms TARGET", centerX, height - 8);
    ctx.textAlign = "right";
    ctx.fillStyle = AGE_COLORS.FOG;
    ctx.fillText("22.98 ms", width - padRight, height - 8);

    ctx.textAlign = "right";
    ctx.fillText(String(maxCount), padLeft - 6, padTop + 9);
    ctx.fillText("0", padLeft - 6, padTop + plotH);
  }, [jitterSamplesUs]);

  return (
    <section className="bg-slate border-[1.5px] border-steel rounded-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
        <h2 className="font-sans text-base font-semibold text-mist">
          44 Hz Frame Timing &amp; Jitter Histogram
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="bg-pitch border border-steel rounded-md px-3 py-1.5">
            <div className="font-mono text-[10px] uppercase text-fog">
              MEAN INTERVAL
            </div>
            <div className="font-mono text-sm font-medium text-mist">
              {(telemetry.meanUs / 1000).toFixed(3)} ms
            </div>
          </div>

          <div className="bg-pitch border border-steel rounded-md px-3 py-1.5">
            <div className="font-mono text-[10px] uppercase text-fog">
              P99 JITTER
            </div>
            <div className="font-mono text-sm font-medium text-mist">
              ±{telemetry.p99JitterUs.toFixed(1)} µs
            </div>
          </div>

          <div className="bg-pitch border border-steel rounded-md px-3 py-1.5">
            <div className="font-mono text-[10px] uppercase text-fog">
              MAX JITTER
            </div>
            <div className="font-mono text-sm font-medium text-ember">
              ±{telemetry.maxJitterUs.toFixed(1)} µs
            </div>
          </div>

          <div
            className={`bg-pitch border rounded-md px-3 py-1.5 ${
              telemetry.droppedFrames > 0 ? "border-signal" : "border-steel"
            }`}
          >
            <div className="font-mono text-[10px] uppercase text-fog">
              DROPPED FRAMES
            </div>
            <div
              className={`font-mono text-sm font-medium ${
                telemetry.droppedFrames > 0 ? "text-signal" : "text-pine"
              }`}
            >
              {telemetry.droppedFrames} ({jitterSamplesUs.length}/256)
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-md overflow-hidden border border-steel bg-pitch">
        <canvas
          ref={canvasRef}
          width={960}
          height={150}
          className="w-full h-[150px] block"
        />
      </div>
    </section>
  );
}
