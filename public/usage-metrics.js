import { PRICE_CATALOG, PRICING_DATE, simulateCost } from "./cost-simulator.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const num = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) : "Unavailable";
const short = value => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const money = (minor, currency) => Number.isFinite(minor) ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100) : "Unavailable";
const dateTime = value => value ? new Date(value).toLocaleString() : "No successful report";
const windowLabel = key => ({ fiveHourUsed: "5-hour", weeklyUsed: "Weekly", reserveUsed: "Reserve" })[key];
const COLORS = ["#e07a2f", "#27896d", "#5879d6", "#9a62c7", "#c84f67", "#1685a5"];
const card = (label, value, detail = "") => `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`;

function tokenChart(data, cumulative = false) {
  if (!data.daily.length) return '<p class="board-empty">No daily token buckets reported for this range.</p>';
  const width = 620, height = 210, left = 48, right = 10, top = 16, bottom = 177;
  const rows = data.accounts.filter(row => !row.duplicateOf);
  const points = data.daily;
  let running = 0;
  const sums = points.map(point => running += point.tokens);
  const max = Math.max(1, ...(cumulative ? sums : points.map(point => point.tokens)));
  const start = Date.parse(points[0].date), end = Date.parse(points.at(-1).date);
  const span = Math.max(86_400_000, end - start + 86_400_000);
  const x = date => left + (Date.parse(date) - start + 43_200_000) / span * (width - left - right);
  const y = value => bottom - value / max * (bottom - top);
  const bar = Math.max(1, Math.min(26, (width - left - right) / (span / 86_400_000) * 0.78));
  const grid = [0, .5, 1].map(fraction => `<line x1="${left}" x2="${width - right}" y1="${y(fraction * max)}" y2="${y(fraction * max)}" class="metrics-grid"/><text x="${left - 7}" y="${y(fraction * max) + 4}" text-anchor="end">${esc(short(fraction * max))}</text>`).join("");
  let marks;
  if (cumulative) {
    marks = `<path class="metrics-cumulative" d="${points.map((point, i) => `${i && Date.parse(point.date) - Date.parse(points[i - 1].date) === 86_400_000 ? "L" : "M"}${x(point.date)},${y(sums[i])}`).join(" ")}"/>`;
    marks += points.map((point, i) => `<circle cx="${x(point.date)}" cy="${y(sums[i])}" r="2.5" class="metrics-dot"><title>${esc(point.date)}: ${num(sums[i])} reported cumulative tokens</title></circle>`).join("");
  } else {
    marks = points.map(point => {
      let offset = 0;
      return rows.map((row, i) => {
        const value = point.accounts[row.id];
        if (!Number.isFinite(value)) return "";
        const result = `<rect x="${x(point.date) - bar / 2}" y="${y(offset + value)}" width="${bar}" height="${Math.max(0, y(offset) - y(offset + value))}" fill="${COLORS[(row.colorIndex ?? i) % COLORS.length]}"><title>${esc(row.label)} · ${esc(point.date)}: ${num(value)} tokens</title></rect>`;
        offset += value;
        return result;
      }).join("");
    }).join("");
  }
  const ticks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(i => `<text x="${x(points[i].date)}" y="${height - 8}" text-anchor="middle">${esc(points[i].date.slice(5))}</text>`).join("");
  const legend = cumulative ? "" : `<div class="metrics-legend">${rows.map((row, i) => `<span><i style="background:${COLORS[(row.colorIndex ?? i) % COLORS.length]}"></i>${esc(row.label)}</span>`).join("")}</div>`;
  return `<svg class="metrics-token-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${cumulative ? "Cumulative" : "Daily"} reported tokens; unknown days are gaps">${grid}${marks}${ticks}</svg>${legend}`;
}

function forecastChart(forecast) {
  if (!forecast.observedTo || !forecast.resetsAt || !Number.isFinite(forecast.projectedAtReset)) return "";
  const width = 280, height = 70, left = 8, right = 272, top = 7, bottom = 55;
  const end = Math.min(forecast.resetsAt * 1000, Date.parse(forecast.exhaustionAt) || Infinity);
  const finalUsed = forecast.status === "at-risk" ? 100 : forecast.projectedAtReset;
  const y = used => bottom - used / 100 * (bottom - top);
  return `<svg class="metrics-forecast-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recent-pace quota projection ending ${esc(dateTime(new Date(end).toISOString()))}">
    <line class="metrics-grid" x1="${left}" x2="${right}" y1="${top}" y2="${top}"/>
    <path class="metrics-forecast-line" d="M${left},${y(forecast.used)} L${right},${y(finalUsed)}"/>
    <circle class="metrics-dot" cx="${left}" cy="${y(forecast.used)}" r="3"/>
    <text x="${left}" y="69">${num(forecast.used)}% now</text><text x="${right}" y="69" text-anchor="end">${num(finalUsed)}% ${forecast.status === "at-risk" ? "at exhaustion" : "at reset"}</text>
  </svg>`;
}

export function initUsageMetrics({ api, getAccounts, onFilter = () => {} }) {
  const $ = id => document.getElementById(id);
  let data = null, generation = 0, lastFetch = 0, pending = null, queued = false, view = "quota";
  let feeSignature = "";
  const filters = () => ({ provider: $("metricsProvider").value, accountId: $("metricsAccount").value, range: $("metricsRange").value });
  function options() {
    const accounts = getAccounts();
    const visible = accounts.filter(account => !$("metricsProvider").value || account.provider === $("metricsProvider").value);
    const value = $("metricsAccount").value;
    const markup = '<option value="">All accounts</option>' + visible.map(account => `<option value="${esc(account.id)}">${esc(account.label)}</option>`).join("");
    if ($("metricsAccount").innerHTML !== markup) {
      $("metricsAccount").innerHTML = markup;
      if (visible.some(account => account.id === value)) $("metricsAccount").value = value;
    }
    const feeOptions = accounts.map(account => `<option value="${esc(account.id)}">${esc(account.label)}</option>`).join("");
    if (feeOptions !== feeSignature) {
      const selected = $("billingAccount").value;
      $("billingAccount").innerHTML = feeOptions;
      if (accounts.some(account => account.id === selected)) $("billingAccount").value = selected;
      feeSignature = feeOptions;
      fillBilling();
    }
  }
  function fillBilling() {
    const account = getAccounts().find(account => account.id === $("billingAccount").value);
    const fee = account?.billing?.filter(entry => entry.effectiveFrom <= new Date().toISOString().slice(0, 10)).at(-1);
    $("billingAmount").value = fee ? fee.amountMinor / 100 : "";
    $("billingCurrency").value = fee?.currency || "EUR";
    $("billingDay").value = fee?.billingDay || 1;
    $("billingEffective").value = new Date().toISOString().slice(0, 10);
    $("billingHistory").innerHTML = account?.billing?.length
      ? `<ul class="billing-history">${account.billing.map(entry => `<li>From ${esc(entry.effectiveFrom)} · ${esc(money(entry.amountMinor, entry.currency))}/month · billing day ${entry.billingDay}</li>`).join("")}</ul>`
      : '<p class="hint">No subscription fees entered for this account.</p>';
  }
  function setView(next) {
    view = next;
    for (const button of document.querySelectorAll("[data-metrics-tab]")) {
      const active = button.dataset.metricsTab === view;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const [name, id] of Object.entries({ quota: "quotaAnalytics", tokens: "tokenAnalytics", costs: "costAnalytics" })) $(id).hidden = name !== view;
    $("metricsRangeLabel").hidden = view === "quota";
    if (view !== "quota") void refresh(true);
  }
  function render() {
    if (!data) return;
    const expandedDetails = document.getElementById("tokenMetricsDetails")?.open;
    const focusOutlook = document.activeElement?.dataset?.simulateOutlook;
    const rows = data.accounts;
    for (const row of rows) row.colorIndex = Math.max(0, getAccounts().findIndex(account => account.id === row.id));
    const unique = rows.filter(row => !row.duplicateOf);
    const dates = data.daily;
    const averages = dates.length ? dates.reduce((sum, point) => sum + point.tokens, 0) / dates.length : null;
    const peak = dates.length ? dates.reduce((best, point) => point.tokens > best.tokens ? point : best) : null;
    $("tokenMetricsSummary").innerHTML = card(`Reported total · ${data.totals.reportedAccounts} of ${data.totals.totalAccounts} accounts`, num(data.totals.tokens), data.totals.complete ? "Account coverage complete; today may be partial" : "Incomplete coverage · unavailable accounts excluded")
      + card("Average per reported date", num(averages), "Unknown dates excluded; partial account coverage possible")
      + card("Peak reported day", num(peak?.tokens), peak?.date || "No daily report")
      + card("Reporting coverage", `${data.totals.reportedAccounts}/${data.totals.totalAccounts}`, `${data.totals.duplicateAccounts} duplicate slots excluded`);
    $("tokenDailyChart").innerHTML = tokenChart(data);
    $("tokenCumulativeChart").innerHTML = tokenChart(data, true);
    $("tokenAccounts").innerHTML = `<table class="metrics-table"><thead><tr><th>Account</th><th>Selected range</th><th>Lifetime</th><th>Daily coverage</th><th>Report</th></tr></thead><tbody>${rows.map(row => `<tr><th>${esc(row.label)}<small>${row.provider === "claude" ? "Claude Code" : "Codex"}${row.duplicateOf ? " · duplicate slot" : ""}</small></th><td>${num(row.usage.tokens)}${row.usage.changePercent !== null ? `<small>${row.usage.changePercent >= 0 ? "+" : ""}${num(row.usage.changePercent)}% · ${row.usage.comparison.days} completed days vs prior ${row.usage.comparison.days}<br>${esc(row.usage.comparison.from)}–${esc(row.usage.comparison.to)}</small>` : ""}</td><td>${num(row.summary.lifetimeTokens)}</td><td>${row.usage.reportedDays} reported${row.usage.expectedDays ? ` / ${row.usage.expectedDays}` : ""}<small>${row.usage.complete ? "Covered" : "Partial / unavailable"}</small></td><td><span class="metrics-status" data-status="${esc(row.status)}">${esc(row.status)}</span>${row.identityVerified || row.provider === "claude" ? "" : "<small>Identity unverified · totals may overlap</small>"}<small>${esc(dateTime(row.updatedAt))}</small></td></tr>`).join("")}</tbody></table>
      <details id="tokenMetricsDetails" class="console-disclosure" ${expandedDetails ? "open" : ""}><summary>Account activity details and daily data</summary>${rows.map(row => `<p><strong>${esc(row.label)}</strong> · peak day ${num(row.summary.peakDailyTokens)} tokens · streak ${num(row.summary.currentStreakDays)} days · longest streak ${num(row.summary.longestStreakDays)} days · longest turn ${num(row.summary.longestRunningTurnSec)} seconds</p>`).join("")}
      <p class="hint">${esc(data.dateBasis)}. Lifetime counts may include dates outside the retained daily history. A reported zero differs from an absent date.</p>
      <table class="metrics-table"><thead><tr><th>Provider date</th>${unique.map(row => `<th>${esc(row.label)}</th>`).join("")}</tr></thead><tbody>${dates.map(point => `<tr><th>${esc(point.date)}</th>${unique.map(row => `<td>${num(point.accounts[row.id])}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;
    $("tokenOutlook").innerHTML = unique.map(row => {
      const forecast = row.outlook;
      const ready = Number.isFinite(forecast.projectedTokens);
      return `<article class="outlook-card"><h4>${esc(row.label)}</h4><strong>${ready ? num(forecast.projectedTokens) + " tokens" : "Unavailable"}</strong><p>${ready ? forecast.status === "month-end" ? "Month-end estimate" : "30-day pace scenario · month-to-date coverage incomplete" : esc(forecast.status === "unsupported" ? "No account-wide token report for Claude Pro/Max" : forecast.status === "stale" ? "Report is stale" : "Needs at least 3 consecutive completed provider days")}</p>${ready ? `<small>If recent usage continues · ${forecast.baselineDays} days, ${esc(forecast.observedFrom)}–${esc(forecast.observedTo)} · ${num(forecast.dailyMean)} tokens/day</small><button type="button" data-simulate-outlook="${esc(row.id)}">Use in cost scenario</button>` : ""}</article>`;
    }).join("");
    $("quotaProjections").innerHTML = `<div class="metrics-section-head"><h3>Quota outlook</h3><p class="hint">If recent usage continues · raw quota windows forecast independently</p></div><div class="metrics-outlook">${unique.map(row => `<article class="outlook-card"><h4>${esc(row.label)}</h4>${row.limitingWindow ? `<p class="metrics-risk">Earliest limiting window: ${windowLabel(row.limitingWindow)}</p>` : ""}${row.forecasts.map(forecast => {
      const label = ({ insufficient: "Needs 3 readings over at least 30 minutes", stale: "Reading stale · projection unavailable", idle: "No measurable recent consumption", blocked: "Provider reports ordinary usage blocked", exhausted: "Quota exhausted", "at-risk": "Projected exhaustion before reset", "reset-first": "Reset before projected exhaustion" })[forecast.status];
      return `<div class="forecast-window"><strong>${windowLabel(forecast.key)}</strong><span class="metrics-status" data-status="${esc(forecast.status)}">${esc(label)}</span>${Number.isFinite(forecast.ratePerHour) ? `<p>${num(forecast.ratePerHour)} pp/hour · ${num(forecast.allowedRatePerHour)} pp/hour to last until reset</p>${forecast.exhaustionAt ? `<small>Exhaustion: ${esc(dateTime(forecast.exhaustionAt))}</small>` : ""}${forecastChart(forecast)}` : ""}${forecast.observedFrom ? `<small>Trend: ${forecast.points} readings from ${esc(dateTime(forecast.observedFrom))}</small>` : ""}</div>`;
    }).join("")}</article>`).join("")}</div>`;
    $("costMetricsSummary").innerHTML = Object.entries(data.totals.configuredMonthlyFees).map(([currency, value]) => card("Configured monthly fees", money(value, currency), "User-entered commitment · not an invoice")).join("")
      + data.totals.reportedExtraUsage.map(group => card(`Reported extra usage · ${group.period}`, money(group.spentMinor, group.currency), `${group.reportedAccounts}/${data.totals.totalAccounts} accounts${group.stale ? " · includes stale readings" : ""}`)).join("")
      + card("Fee coverage", `${data.totals.configuredFeeAccounts}/${data.totals.totalAccounts}`, "Extra usage reported separately; currencies are not converted");
    $("costAccounts").innerHTML = `<table class="metrics-table"><thead><tr><th>Account</th><th>Configured subscription</th><th>Reported extra usage</th><th>Subscription cost / 1M coding tokens</th></tr></thead><tbody>${rows.map(row => {
      const fee = row.costs.monthlyFee, extra = row.costs.extraUsage, efficiency = row.costs.efficiency;
      const stale = extra?.updatedAt && Date.now() - Date.parse(extra.updatedAt) > 1_200_000;
      return `<tr><th>${esc(row.label)}${row.duplicateOf ? "<small>Duplicate · excluded from totals</small>" : ""}</th><td>${fee ? esc(money(fee.amountMinor, fee.currency)) + "/month" : "Not entered"}${fee ? `<small>User-entered · billing day ${fee.billingDay}</small>` : ""}</td><td>${extra ? esc(money(extra.spentMinor, extra.currency)) : "Unavailable"}${extra ? `<small>${esc(extra.period || "Period not reported")}${extra.limitMinor !== null ? ` · limit ${esc(money(extra.limitMinor, extra.currency))}` : " · no reported limit"}${stale ? " · stale" : ""}</small><small>${esc(dateTime(extra.updatedAt))}</small>` : "<small>No account spend amount reported</small>"}</td><td>${efficiency ? esc(money(efficiency.perMillionMinor, efficiency.currency)) + `<small>${esc(efficiency.period)} · subscription fee only</small>` : "Unavailable"}</td></tr>`;
    }).join("")}</tbody></table><p class="hint">Subscription fees may cover other products too. This ratio is a comparison against reported coding tokens, not a billed coding rate. Missing spend is unknown, including an Unlimited row without an amount.</p>`;
    const reported = unique.filter(row => row.usage.tokens !== null).length;
    $("metricsFeedback").textContent = `${reported}/${unique.length} accounts report tokens · refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
    prefillVolume();
    if (focusOutlook) [...document.querySelectorAll("[data-simulate-outlook]")].find(button => button.dataset.simulateOutlook === focusOutlook)?.focus({ preventScroll: true });
  }
  async function refresh(force = false) {
    options();
    if (pending) { if (force) queued = true; return pending; }
    if (!force && Date.now() - lastFetch < 15_000) return;
    const version = ++generation;
    const query = new URLSearchParams(filters());
    pending = (async () => {
      try {
        const result = await api(`/api/usage-metrics?${query}`);
        if (version !== generation || query.toString() !== new URLSearchParams(filters()).toString()) return;
        data = result;
        lastFetch = Date.now();
        render();
      } catch (error) {
        $("metricsFeedback").textContent = `${data ? "Cached display · " : ""}Metrics unavailable: ${error.message}`;
      } finally {
        pending = null;
        if (queued) { queued = false; void refresh(true); }
      }
    })();
    return pending;
  }
  function prefillVolume() {
    if (!data) return;
    const mode = $("scenarioVolume").value;
    if (mode === "manual") return;
    let volume = data.totals.tokens;
    if (mode === "outlook") {
      const rows = data.accounts.filter(row => !row.duplicateOf);
      volume = rows.length && rows.every(row => Number.isFinite(row.outlook.projectedTokens))
        && new Set(rows.map(row => row.outlook.status)).size === 1 ? rows.reduce((sum, row) => sum + row.outlook.projectedTokens, 0) : null;
    }
    $("scenarioTokens").value = Number.isFinite(volume) ? Math.round(volume) : "";
    $("scenarioResult").textContent = Number.isFinite(volume) ? "" : "No compatible token volume available for the selected accounts. Select a reporting account or enter a scenario volume.";
  }
  function setRates() {
    const row = PRICE_CATALOG.find(item => item.model === $("scenarioModel").value);
    if (!row) {
      for (const id of ["rateInput", "rateOutput", "rateRead", "rateWrite"]) $(id).value = "";
      $("scenarioBasis").textContent = "Custom model · enter all rates in USD per million tokens.";
      return;
    }
    $("rateInput").value = row.input;
    $("rateOutput").value = row.output;
    $("rateRead").value = row.read;
    $("rateWrite").value = $("scenarioTTL").value === "long" ? row.writeLong : row.writeShort;
    $("scenarioBasis").innerHTML = `Standard text pricing snapshot ${PRICING_DATE} · <a href="${row.source}" target="_blank" rel="noreferrer">Official rates</a>. Rates are editable. Claude Haiku 5.5 rates apply to prompts up to 100k tokens.`;
  }
  $("scenarioModel").insertAdjacentHTML("beforeend", PRICE_CATALOG.map(row => `<option value="${row.model}">${row.model}</option>`).join("") + '<option value="custom">Custom model / rates</option>');
  for (const button of document.querySelectorAll("[data-metrics-tab]")) {
    button.addEventListener("click", () => setView(button.dataset.metricsTab));
    button.addEventListener("keydown", event => {
      const buttons = [...document.querySelectorAll("[data-metrics-tab]")];
      const index = buttons.indexOf(button);
      const next = event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      setView(buttons[next].dataset.metricsTab);
      buttons[next].focus();
    });
  }
  for (const id of ["metricsProvider", "metricsAccount", "metricsRange"]) $(id).addEventListener("change", () => {
    options();
    generation++;
    $("scenarioResult").textContent = "";
    onFilter(filters());
    void refresh(true);
  });
  $("billingAccount").addEventListener("change", fillBilling);
  $("billingForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter || $("billingForm").querySelector("button");
    button.disabled = true;
    const accountId = $("billingAccount").value;
    try {
      const result = await api(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify({ billing: {
        amountMinor: Math.round(Number($("billingAmount").value) * 100), currency: $("billingCurrency").value,
        billingDay: Number($("billingDay").value), effectiveFrom: $("billingEffective").value
      } }) });
      const account = getAccounts().find(item => item.id === accountId);
      if (account) account.billing = result.account.billing;
      $("billingFeedback").textContent = "Subscription fee saved · user-entered.";
      fillBilling();
      await refresh(true);
    } catch (error) { $("billingFeedback").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("scenarioTokens").addEventListener("input", () => { $("scenarioVolume").value = "manual"; });
  $("scenarioModel").addEventListener("change", setRates);
  $("scenarioTTL").addEventListener("change", setRates);
  $("scenarioVolume").addEventListener("change", prefillVolume);
  $("costSimulator").addEventListener("input", () => { $("scenarioResult").textContent = ""; });
  $("costSimulator").addEventListener("submit", event => {
    event.preventDefault();
    try {
      const number = id => $(id).value.trim() ? Number($(id).value) : NaN;
      const result = simulateCost({ tokens: number("scenarioTokens"), outputPercent: number("scenarioOutput"),
        cacheReadPercent: number("scenarioRead"), cacheWritePercent: number("scenarioWrite"),
        rates: { input: number("rateInput"), output: number("rateOutput"), read: number("rateRead"), write: number("rateWrite") } });
      $("scenarioResult").innerHTML = `<strong>${esc(money(result.costUSD * 100, "USD"))} · API-cost scenario</strong><p>${esc($("scenarioModel").value)} · ${num(number("scenarioTokens"))} tokens · ${num(number("scenarioOutput"))}% output · ${num(number("scenarioRead"))}% input cache reads · ${num(number("scenarioWrite"))}% input cache writes · ${esc($("scenarioTTL").selectedOptions[0].textContent)}</p><p>Difference vs uncached: ${esc(money(result.cacheDifferenceUSD * 100, "USD"))}. Pricing snapshot ${PRICING_DATE}${$("scenarioModel").value === "custom" ? " · user-entered rates" : " · editable rates"}.</p><small>Hypothetical equivalent, not a charge or measured account cost. ${$("scenarioVolume").value === "outlook" ? "If recent usage continues · baseline " + data.accounts.filter(row => !row.duplicateOf).map(row => `${row.outlook.observedFrom}–${row.outlook.observedTo}`).join(", ") + ". " : ""}${esc($("metricsFeedback").textContent)}</small>`;
    } catch (error) { $("scenarioResult").textContent = error.message; }
  });
  $("tokenOutlook").addEventListener("click", event => {
    const button = event.target.closest("[data-simulate-outlook]");
    if (!button) return;
    const row = data?.accounts.find(account => account.id === button.dataset.simulateOutlook);
    if (!Number.isFinite(row?.outlook.projectedTokens)) return;
    $("metricsAccount").value = row.id;
    $("scenarioVolume").value = "outlook";
    onFilter(filters());
    setView("costs");
  });
  return { refresh, filters };
}
