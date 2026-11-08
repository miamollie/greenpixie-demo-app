const chart = document.querySelector("#emissions-chart");
const chartError = document.querySelector("#chart-error");
const number = (value) => new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);

function render(data) {
  const totals = data.periods.map((_, index) => data.series.reduce((sum, item) => sum + item.values[index], 0));
  const last = totals.length - 1;
  const change = (totals[last] / totals[last - 1] - 1) * 100;

  document.querySelector("#latest-total").textContent = `${number(totals[last])} kg`;
  document.querySelector("#latest-period").textContent = `${data.periods[last]} · CO₂e`;
  document.querySelector("#monthly-change").textContent = `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
  document.querySelector("#monthly-change").classList.add(change < 0 ? "is-down" : change > 0 ? "is-up" : "is-flat");
  document.querySelector("#period-count").textContent = String(data.periods.length);
  document.querySelector("#data-caveat").textContent = data.methodology;
  if (data.dataset !== "demo") document.querySelector(".demo-stamp").hidden = true;

  const plot = new uPlot({
    width: chart.clientWidth,
    height: chart.clientHeight,
    legend: { show: false },
    scales: { x: { time: false } },
    axes: [
      {
        stroke: "#87948b",
        grid: { stroke: "#e9eee6", width: 1 },
        values: (_, ticks) => ticks.map((index) => data.periods[Math.round(index)] ?? ""),
      },
      {
        stroke: "#87948b",
        grid: { stroke: "#e9eee6", width: 1 },
        values: (_, ticks) => ticks.map(number),
      },
    ],
    series: [
      {},
      { label: "Total emissions (kg CO₂e)", stroke: "#245b43", width: 3, points: { show: true, size: 6, fill: "#245b43" } },
    ],
  }, [data.periods.map((_, index) => index), totals], chart);

  new ResizeObserver(() => plot.setSize({ width: chart.clientWidth, height: chart.clientHeight })).observe(chart);
}

fetch("./data/emissions.json", { cache: "no-store" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("Emissions data could not be loaded")))
  .then(render)
  .catch(() => {
    chart.hidden = true;
    chartError.hidden = false;
    document.querySelector("#latest-total").textContent = "Unavailable";
    document.querySelector("#latest-period").textContent = "Data could not be loaded";
  });