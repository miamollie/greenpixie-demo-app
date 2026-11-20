const chart = document.querySelector("#emissions-chart");
const chartError = document.querySelector("#chart-error");
const number = (value) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
let chartModel;
let chartPlot;

new ResizeObserver(() => {
  if (!chartPlot) return;
  const width = chart.clientWidth;
  if (Math.abs(width - chartModel?.width) < 1) return;
  chartModel = { ...chartModel, width };
  chartPlot.setSize({
    width: Math.max(width, chartModel.periodCount * 72 + 84),
    height: chartPlot.height,
  });
}).observe(chart);

function renderChart(data) {
  if (chartPlot) chartPlot.destroy();
  chart.replaceChildren();

  const timestamps = data.periods.map((period) => {
    const [year, month] = period.split("-").map(Number);
    return Date.UTC(year, month - 1, 1) / 1000;
  });
  const values = data.series.map((series) => series.values);
  const largestValue = Math.max(
    0,
    ...values.flatMap((seriesValues) => seriesValues),
  );

  const options = {
    width: Math.max(chart.clientWidth, data.periods.length * 72 + 84),
    height: window.matchMedia("(max-width: 680px)").matches ? 250 : 300,
    legend: { live: true },
    cursor: { drag: { x: false, y: false } },
    scales: {
      x: { time: true },
      y: { range: [0, Math.max(largestValue * 1.12, 100)] },
    },
    axes: [
      {
        values: (self, ticks) =>
          ticks.map((timestamp) =>
            new Intl.DateTimeFormat("en", {
              month: "short",
              year: "2-digit",
              timeZone: "UTC",
            }).format(new Date(timestamp * 1000)),
          ),
      },
      {
        label: data.unit ?? "kg CO2e",
        values: (self, ticks) => ticks.map(number),
      },
    ],
    series: [
      { label: "Month" },
      ...data.series.map((series) => ({
        label: series.label,
        width: 2,
      })),
    ],
  };

  chartPlot = new uPlot(options, [timestamps, ...values], chart);
}

function render(data) {
  if (!Array.isArray(data.periods) || !Array.isArray(data.series)) {
    throw new Error("Emissions data must contain periods and series");
  }
  const periods = data.periods;
  const totals = periods.map((_, index) =>
    data.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
  );
  const last = totals.length - 1;
  const change =
    last > 0 && totals[last - 1] !== 0
      ? (totals[last] / totals[last - 1] - 1) * 100
      : null;

  document.querySelector("#latest-total").textContent =
    `${number(totals[last])} kg`;
  document.querySelector("#latest-period").textContent =
    `${data.periods[last]} · CO₂e`;
  document.querySelector("#monthly-change").textContent =
    change === null ? "--" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
  if (change !== null) {
    document
      .querySelector("#monthly-change")
      .classList.add(change < 0 ? "is-down" : change > 0 ? "is-up" : "is-flat");
  }

  chartModel = { width: chart.clientWidth, periodCount: periods.length };
  renderChart(data);
}

async function loadData() {
  try {
    const live = await fetch("/data/emissions.json", { cache: "no-store" });
    if (live.ok) return await live.json();
  } catch {
    // Keep the chart available while live data is unavailable.
  }

  const demo = await fetch("/data/demo-emissions.json", { cache: "no-store" });
  if (demo.ok) return await demo.json();
  throw new Error("Emissions data could not be loaded");
}

loadData()
  .then(render)
  .catch(() => {
    chart.hidden = true;
    chartError.hidden = false;
    document.querySelector("#latest-total").textContent = "Unavailable";
    document.querySelector("#latest-period").textContent =
      "Data could not be loaded";
  });
