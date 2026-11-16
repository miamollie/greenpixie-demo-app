const chart = document.querySelector("#emissions-chart");
const chartError = document.querySelector("#chart-error");
const svgNamespace = "http://www.w3.org/2000/svg";
const chartColors = ["#245b43", "#b46545", "#39758a", "#aa8a38", "#715c79"];
const number = (value) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
let chartModel;

new ResizeObserver(() => {
  if (!chartModel) return;
  const width = chart.clientWidth;
  if (Math.abs(width - chartModel.width) < 1) return;
  chartModel.width = width;
  renderChart(chartModel.periods, chartModel.contributors, chartModel.totals);
}).observe(chart);

const serviceLabels = {
  AmazonCloudWatch: "CloudWatch",
  AmazonEC2: "EC2",
  AmazonRDS: "RDS",
  AmazonS3: "S3",
};

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function observationsFrom(data) {
  if (Array.isArray(data.observations)) return data.observations;
  return data.series.flatMap((item) =>
    data.periods.map((period, index) => ({
      period,
      service: item.label,
      resource: "All resources",
      emissions_kg_co2e: item.values[index] ?? 0,
    })),
  );
}

function groupObservations(periods, observations) {
  const grouped = new Map();
  for (const observation of observations) {
    const periodIndex = periods.indexOf(observation.period);
    if (periodIndex < 0) continue;

    const service = observation.service || "Unknown service";
    const resource = observation.resource || "Unspecified";
    const key = `${service}\u0000${resource}`;
    const contributor = grouped.get(key) ?? {
      label: `${serviceLabels[service] ?? service} · ${resource}`,
      values: Array(periods.length).fill(0),
    };
    contributor.values[periodIndex] += Number(observation.emissions_kg_co2e);
    grouped.set(key, contributor);
  }

  return [...grouped.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((contributor, index) => ({
      ...contributor,
      color: chartColors[index % chartColors.length],
    }));
}

function renderChart(periods, contributors, totals) {
  chart.replaceChildren();
  const width = Math.max(chart.clientWidth, periods.length * 72 + 84);
  const height = window.matchMedia("(max-width: 680px)").matches ? 250 : 300;
  const margin = { top: 24, right: 18, bottom: 42, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const largestTotal = Math.max(...totals, 0);
  const tickStep = Math.max(100, Math.ceil(largestTotal / 4 / 100) * 100);
  const yMaximum = tickStep * 4;
  const plotBottom = margin.top + plotHeight;
  const svg = svgElement("svg", {
    class: "chart-svg",
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label":
      "Monthly estimated emissions by AWS service and resource, in kilograms of carbon dioxide equivalent",
  });
  const title = svgElement("title");
  title.textContent = "Monthly emissions by AWS service and resource";
  svg.append(title);

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = tick * tickStep;
    const y = plotBottom - (value / yMaximum) * plotHeight;
    svg.append(
      svgElement("line", {
        class: "chart-grid",
        x1: margin.left,
        x2: width - margin.right,
        y1: y,
        y2: y,
      }),
    );
    const label = svgElement("text", {
      class: "chart-axis-label",
      x: margin.left - 10,
      y: y + 4,
      "text-anchor": "end",
    });
    label.textContent = number(value);
    svg.append(label);
  }

  const cellWidth = plotWidth / periods.length;
  const barWidth = Math.min(68, cellWidth * 0.58);
  periods.forEach((period, periodIndex) => {
    const center = margin.left + cellWidth * (periodIndex + 0.5);
    let stackedTotal = 0;
    contributors.forEach((contributor) => {
      const value = contributor.values[periodIndex] ?? 0;
      if (value <= 0) return;
      const segmentHeight = (value / yMaximum) * plotHeight;
      const rect = svgElement("rect", {
        x: center - barWidth / 2,
        y: plotBottom - ((stackedTotal + value) / yMaximum) * plotHeight,
        width: barWidth,
        height: segmentHeight,
        fill: contributor.color,
        rx: 2,
      });
      const tooltip = svgElement("title");
      tooltip.textContent = `${contributor.label}: ${number(value)} kg CO₂e · ${period}`;
      rect.append(tooltip);
      svg.append(rect);
      stackedTotal += value;
    });

    const totalLabel = svgElement("text", {
      class: "chart-total-label",
      x: center,
      y: plotBottom - (totals[periodIndex] / yMaximum) * plotHeight - 7,
      "text-anchor": "middle",
    });
    totalLabel.textContent = number(totals[periodIndex]);
    svg.append(totalLabel);

    const [year, month] = period.split("-").map(Number);
    const monthLabel = new Intl.DateTimeFormat("en", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, 1)));
    const periodLabel = svgElement("text", {
      class: "chart-axis-label",
      x: center,
      y: height - 12,
      "text-anchor": "middle",
    });
    periodLabel.textContent = monthLabel;
    svg.append(periodLabel);
  });

  const legend = document.createElement("ul");
  legend.className = "chart-legend";
  legend.setAttribute("aria-label", "Emissions by service and resource");
  for (const contributor of contributors) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "chart-legend-swatch";
    swatch.style.backgroundColor = contributor.color;
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = contributor.label;
    item.append(swatch, label);
    legend.append(item);
  }
  chart.append(svg, legend);
}

function render(data) {
  const periods = data.periods;
  const contributors = groupObservations(periods, observationsFrom(data));
  const totals = periods.map((_, index) =>
    contributors.reduce(
      (sum, contributor) => sum + contributor.values[index],
      0,
    ),
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
  document.querySelector("#period-count").textContent = String(periods.length);
  document.querySelector("#data-caveat").textContent = data.methodology;
  const demoStamp = document.querySelector(".demo-stamp");
  if (data.dataset !== "demo" && demoStamp) demoStamp.hidden = true;
  chartModel = {
    periods,
    contributors,
    totals,
    width: chart.clientWidth,
  };
  renderChart(periods, contributors, totals);
}

async function loadData() {
  try {
    const live = await fetch("/data/emissions.json", { cache: "no-store" });
    if (live.ok) return await live.json();
  } catch {
    // Keep the chart available while live data is unavailable.
  }

  const demo = await fetch("/data/demo-emissions.json");
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
