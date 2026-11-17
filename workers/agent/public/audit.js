// The audit view. It reads rows through the agent Worker, which reads them
// from the gatekeeper. Every value is put on the page as text, never as HTML.

const params = new URLSearchParams(location.search);
const opportunityId = params.get("opportunity");
const app = document.getElementById("app");
let jumped = false;

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message || "";
  box.hidden = !message;
}

const ACTION_KIND = { write: "ok", approve: "ok", edit: "ok", refuse: "no", reject: "no", drop: "pending" };

const FIELD_LABELS = {
  Metrics__c: "Metrics",
  Economic_Buyer__c: "Economic Buyer",
  Decision_Criteria__c: "Decision Criteria",
  Decision_Process__c: "Decision Process",
  Paper_Process__c: "Paper Process",
  Identified_Pain__c: "Identified Pain",
  Champion__c: "Champion",
  Competition__c: "Competition",
  CloseDate: "Close Date",
};

function parseDetail(row) {
  try {
    return row.detail ? JSON.parse(row.detail) : {};
  } catch {
    return {};
  }
}

// What happened, in one line, from the row's own columns.
function describe(row, detail) {
  const field = row.field ? FIELD_LABELS[row.field] || row.field : "";
  switch (row.action) {
    case "read":
      return row.reason ? `Read the opportunity (${row.reason})` : "Read the opportunity and kept a snapshot of its values";
    case "propose":
      return `Proposed ${field}`;
    case "drop":
      return field ? `Dropped its own proposal for ${field}` : "Dropped the whole model answer";
    case "approve":
      return `Approved ${field}`;
    case "edit":
      return `Edited and approved ${field}`;
    case "reject":
      return `Rejected ${field}`;
    case "write":
      return row.outcome === "applied" ? `Wrote ${field} to Salesforce` : `Tried to write ${field}; Salesforce did not accept it`;
    case "refuse":
      if (detail.attempted === "decision") return `Refused a decision on ${field || "a field"}`;
      if (detail.attempted === "log_proposal") return "Refused to record a proposal";
      return `Refused a write to ${field || "a field"}`;
    default:
      return row.action;
  }
}

function pair(label, value, mono) {
  if (value === null || value === undefined || value === "") return null;
  return el("div", { class: "kv" }, [el("dt", { text: label }), el("dd", { class: mono ? "mono" : "", text: String(value) })]);
}

function renderRow(row) {
  const detail = parseDetail(row);
  const isAgent = row.actor.startsWith("agent:");
  // Which values a row carries depends on what happened. A propose or write
  // row knows the value before. A decision, a drop or a direct refusal only
  // carries the value in question, so no "before" is shown for those.
  const AFTER_LABEL = { propose: "Value proposed", approve: "Value approved", edit: "Value approved", drop: "Value dropped", refuse: "Value asked for", write: "Value after" };
  const showBefore = row.action === "propose" || row.action === "write" || row.value_before !== null;
  const column = (label, value, none) => el("div", {}, [el("p", { class: "label", text: label }), el("p", { class: `value${value ? "" : " empty"}`, text: value || none })]);
  const values =
    row.value_before !== null || row.value_after !== null
      ? el("div", { class: "values" }, [
          showBefore ? column("In Salesforce before", row.value_before, "Empty") : null,
          column(AFTER_LABEL[row.action] || "Value", row.value_after, "None"),
        ])
      : null;

  return el("section", { class: `field audit-row action-${row.action}`, attrs: { id: `row-${row.seq}` } }, [
    el("div", { class: "field-head" }, [
      el("h3", {}, [el("span", { class: "seq", text: `#${row.seq}` }), document.createTextNode(` ${describe(row, detail)}`)]),
      el("span", { class: `pill ${ACTION_KIND[row.action] || ""}`, text: `${row.action} · ${row.outcome}` }),
    ]),
    el("p", { class: "who" }, [
      el("span", { class: `actor ${isAgent ? "is-agent" : "is-person"}`, text: `${isAgent ? "Agent" : "Person"}: ${row.actor.replace(/^[a-z]+:/, "")}` }),
      document.createTextNode(` · ${new Date(row.time).toLocaleString()}`),
    ]),
    row.reason ? el("p", { class: `note ${row.outcome === "refused" || row.outcome === "failed" ? "no" : "muted"}`, text: row.reason }) : null,
    values,
    detail.quote ? el("div", { class: "quotes" }, [el("p", { class: "label", text: "From the call" }), ...String(detail.quote).split("\n").map((quote) => el("blockquote", { text: quote }))]) : null,
    el("details", { class: "more" }, [
      el("summary", { text: "Sources and hashes" }),
      el("dl", {}, [
        pair("Policy rule", detail.rule),
        pair("Reason code", detail.code),
        pair("Approved by", detail.approved_by),
        pair("Agent proposed", detail.proposed_value),
        pair("Proposal", row.proposal_id, true),
        pair("Model", row.model_id, true),
        pair("Transcript hash", row.transcript_hash, true),
        pair("Context file hash", row.context_hash, true),
        pair("Policy file hash", row.policy_hash, true),
        pair("Opportunity", row.opportunity_id, true),
        pair("Previous row hash", row.prev_hash, true),
        pair("This row hash", row.hash, true),
      ]),
    ]),
  ]);
}

function render(rows) {
  document.getElementById("title").textContent = opportunityId ? `Audit log for opportunity ${opportunityId}` : "Audit log, every opportunity";
  const subtitle = document.getElementById("subtitle");
  subtitle.replaceChildren(
    document.createTextNode(`${rows.length} ${rows.length === 1 ? "row" : "rows"}, oldest first. `),
    opportunityId
      ? el("a", { text: "Show every row", attrs: { href: "/audit" } })
      : document.createTextNode("Add ?opportunity=006... to the address to show one opportunity."),
    opportunityId ? document.createTextNode(" · ") : null,
    opportunityId ? el("a", { text: "Back to the review page", attrs: { href: `/review/${opportunityId}` } }) : null,
  );
  if (rows.length === 0) {
    app.replaceChildren(el("div", { class: "empty-state" }, [el("p", { text: "No rows yet. Send a call-ended event, and the gatekeeper will log the read and the proposal." })]));
    return;
  }
  app.replaceChildren(...rows.map(renderRow));
  // Jump to a linked row once, on arrival, and not again when the list reloads.
  if (location.hash && !jumped) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
  jumped = true;
}

async function load() {
  try {
    const response = await fetch(`/api/audit${opportunityId ? `?opportunity=${encodeURIComponent(opportunityId)}` : ""}`);
    const data = await response.json();
    if (!response.ok) return showError(data.error || `The request failed (${response.status}).`);
    render(data.rows);
  } catch (error) {
    showError(`Could not reach the Worker: ${error.message}`);
  }
}

document.getElementById("verify").addEventListener("click", async () => {
  const verdict = document.getElementById("verdict");
  verdict.className = "verdict muted";
  verdict.textContent = "Recomputing the chain...";
  try {
    const response = await fetch("/audit/verify");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `status ${response.status}`);
    const rows = `${result.rowsChecked} ${result.rowsChecked === 1 ? "row" : "rows"}`;
    if (result.ok) {
      verdict.className = "verdict ok";
      verdict.textContent = `Chain intact. ${rows} recomputed across the whole log at ${new Date().toLocaleTimeString()}: every row matches its hash and the hash of the row before it.`;
    } else {
      verdict.className = "verdict no";
      verdict.textContent = `Chain broken${result.badSeq ? ` at row ${result.badSeq}` : ""}: ${result.problem}. ${rows} checked.`;
    }
    await load();
  } catch (error) {
    verdict.className = "verdict no";
    verdict.textContent = `Could not verify: ${error.message}`;
  }
});

load();
