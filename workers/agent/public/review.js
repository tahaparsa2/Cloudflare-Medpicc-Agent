// The review page. Every value is put on the page as text, never as HTML, so a
// transcript or a model answer cannot inject markup.

const opportunityId = location.pathname.split("/").pop();
const api = `/api/opportunities/${opportunityId}`;
const app = document.getElementById("app");
const editing = new Set();
let busy = false;

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  if (options.on) for (const [event, handler] of Object.entries(options.on)) node.addEventListener(event, handler);
  for (const child of children) if (child) node.append(child);
  return node;
}

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message || "";
  box.hidden = !message;
}

async function call(path, body) {
  if (busy) return;
  busy = true;
  showError("");
  try {
    const response = await fetch(api + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      showError(data.error || `The request failed (${response.status}).`);
      return;
    }
    // A decision or an apply answers with the new state. Keep what the first load told us about identity.
    render({ ...current, ...data });
  } catch (error) {
    showError(`Could not reach the Worker: ${error.message}`);
  } finally {
    busy = false;
  }
}

let current = {};

const STATUS = {
  none: "No proposal yet",
  drafted: "Drafted, waiting for your decisions",
  partly_decided: "Partly decided",
  applied: "Applied",
};

function fieldState(field) {
  if (field.result?.outcome === "written") return { text: "Written to Salesforce", kind: "ok" };
  if (field.result?.outcome === "refused") return { text: "Refused by the gatekeeper", kind: "no" };
  if (field.result?.outcome === "failed") return { text: "Salesforce did not accept it", kind: "no" };
  if (field.decision === "approve") return { text: "Approved, not written yet", kind: "pending" };
  if (field.decision === "edit") return { text: "Edited and approved, not written yet", kind: "pending" };
  if (field.decision === "reject") return { text: "Rejected", kind: "no" };
  return { text: "Needs your decision", kind: "" };
}

function renderField(field) {
  const state = fieldState(field);
  const written = field.result?.outcome === "written";
  const isEditing = editing.has(field.field) && !written;
  const shown = field.decision === "edit" && field.decidedValue ? field.decidedValue : field.proposed;

  const proposedColumn = [el("p", { class: "label", text: field.decision === "edit" ? "Your edit" : "Proposed value" })];
  let textarea;
  if (isEditing) {
    textarea = el("textarea", { attrs: { "aria-label": `Edit ${field.label}` } });
    textarea.value = shown;
    proposedColumn.push(textarea);
  } else {
    proposedColumn.push(el("p", { class: "value", text: shown }));
    if (field.decision === "edit") {
      proposedColumn.push(el("p", { class: "was" }, [document.createTextNode("Agent proposed: "), el("s", { text: field.proposed })]));
    }
  }

  const decide = (decision, value) => {
    editing.delete(field.field);
    call("/decisions", { field: field.field, decision, value });
  };

  const actions = written
    ? []
    : isEditing
      ? [
          el("button", { class: "primary", text: "Save edit and approve", on: { click: () => decide("edit", textarea.value) } }),
          el("button", { text: "Cancel", on: { click: () => { editing.delete(field.field); render(current); } } }),
        ]
      : [
          el("button", { class: field.decision === "approve" ? "chosen" : "primary", text: "Approve", on: { click: () => decide("approve") } }),
          el("button", { class: field.decision === "edit" ? "chosen" : "", text: "Edit", on: { click: () => { editing.add(field.field); render(current); } } }),
          el("button", { class: field.decision === "reject" ? "chosen" : "", text: "Reject", on: { click: () => decide("reject") } }),
        ];

  return el("section", { class: `field${written ? " is-written" : ""}${field.decision === "reject" ? " is-rejected" : ""}` }, [
    el("div", { class: "field-head" }, [el("h3", { text: field.label }), el("span", { class: `pill ${state.kind}`, text: state.text })]),
    el("div", { class: "values" }, [
      el("div", {}, [
        el("p", { class: "label", text: written ? "In Salesforce before" : "In Salesforce now" }),
        el("p", { class: `value${field.current ? "" : " empty"}`, text: field.current || "Empty" }),
      ]),
      el("div", {}, proposedColumn),
    ]),
    el("div", { class: "quotes" }, [
      el("p", { class: "label", text: field.quotes.length > 1 ? "Supporting lines from the call" : "Supporting line from the call" }),
      ...field.quotes.map((quote) => el("blockquote", { text: quote })),
    ]),
    field.result && !written ? el("p", { class: "note no", text: field.result.reason }) : null,
    field.decidedBy && field.decision ? el("p", { class: "note muted", text: `Decided by ${field.decidedBy}` }) : null,
    actions.length ? el("div", { class: "actions" }, actions) : null,
  ]);
}

// A forecast field the call says has changed. There is nothing to approve
// here: the card shows what the agent asked the gatekeeper and what it answered.
function renderNotWritable(item) {
  const refused = item.outcome === "refused";
  return el("section", { class: "field is-locked" }, [
    el("div", { class: "field-head" }, [
      el("h3", { text: item.label }),
      el("span", { class: "pill no", text: refused ? "Refused by the gatekeeper" : `Gatekeeper answered: ${item.outcome}` }),
    ]),
    el("div", { class: "values" }, [
      el("div", {}, [
        el("p", { class: "label", text: "In Salesforce now" }),
        el("p", { class: `value${item.current ? "" : " empty"}`, text: item.current || "Empty" }),
      ]),
      el("div", {}, [el("p", { class: "label", text: "What the call says" }), el("p", { class: "value", text: item.requested })]),
    ]),
    el("div", { class: "quotes" }, [
      el("p", { class: "label", text: item.quotes.length > 1 ? "Supporting lines from the call" : "Supporting line from the call" }),
      ...item.quotes.map((quote) => el("blockquote", { text: quote })),
    ]),
    el("p", { class: "note no", text: `Gatekeeper: ${item.reason}.` }),
    el("p", { class: "note muted" }, [
      document.createTextNode(`Decided by policy rule ${item.rule || "none"}. `),
      el("a", { text: `Audit row ${item.auditSeq}`, attrs: { href: `/audit?opportunity=${opportunityId}#row-${item.auditSeq}` } }),
    ]),
  ]);
}

// Stands in for the call recording system: send the "call ended" event for a
// fixture transcript from the page. The terminal command `npm run call` does
// the same thing. A deployed Worker behind Access can only be reached this way.
async function sendCall(transcriptId) {
  if (busy) return;
  busy = true;
  showError("");
  document.getElementById("subtitle").textContent = `Reading ${transcriptId}...`;
  try {
    const response = await fetch("/calls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityId, transcriptId }),
    });
    const data = await response.json();
    if (!response.ok) showError(data.error || `The call event failed (${response.status}).`);
  } catch (error) {
    showError(`Could not reach the Worker: ${error.message}`);
  } finally {
    busy = false;
  }
  editing.clear();
  await call("");
}

function callBar(transcripts) {
  return el("div", { class: "callbar" }, [
    el("p", { class: "muted", text: "Stand-in for the call recording system. Send a call-ended event:" }),
    ...transcripts.map((id) => el("button", { text: `${id} ended`, on: { click: () => sendCall(id) } })),
  ]);
}

function render(data) {
  current = data;
  const { proposal, status, identity } = data;

  const banner = document.getElementById("identity");
  banner.hidden = false;
  banner.className = identity === "access" ? "banner signed-in" : "banner";
  banner.textContent =
    identity === "access"
      ? `Signed in through Cloudflare Access as ${String(data.signedInAs || "").replace(/^user:/, "")}. Your decisions are recorded under this name.`
      : "Local dev identity. This page is not behind Cloudflare Access, so your decisions are recorded under the gatekeeper's dev identity, not your own sign-in.";

  if (!proposal) {
    document.getElementById("title").textContent = "No proposal yet";
    document.getElementById("subtitle").textContent = `Opportunity ${opportunityId}`;
    app.replaceChildren(
      el("div", { class: "empty-state" }, [
        el("p", { text: "No call has been processed for this opportunity. Send a call-ended event below, or from a terminal:" }),
        el("p", { class: "mono", text: "npm run call -- call-1" }),
      ]),
      callBar(data.transcripts || []),
    );
    return;
  }

  document.getElementById("title").textContent = proposal.opportunityName || `Opportunity ${opportunityId}`;
  document.getElementById("subtitle").textContent = [proposal.accountName, STATUS[status] || status].filter(Boolean).join(" · ");

  const waiting = proposal.fields.filter((f) => (f.decision === "approve" || f.decision === "edit") && f.result?.outcome !== "written");
  const undecided = proposal.fields.filter((f) => !f.decision);
  const written = proposal.fields.filter((f) => f.result?.outcome === "written");

  const parts = [
    el("ul", { class: "facts" }, [
      el("li", {}, [document.createTextNode("Call "), el("b", { text: proposal.transcriptId })]),
      el("li", {}, [
        document.createTextNode("Model "),
        el("b", { class: "mono", text: proposal.modelId.replace(/^replay:/, "") }),
        document.createTextNode(" "),
        proposal.modelId.startsWith("replay:")
          ? el("span", { class: "pill pending", text: "Replayed recording", attrs: { title: "No model was called. A saved answer from an earlier live call was replayed." } })
          : el("span", { class: "pill ok", text: "Live model call" }),
      ]),
      el("li", {}, [document.createTextNode("Drafted "), el("b", { text: new Date(proposal.createdAt).toLocaleString() })]),
      el("li", {}, [document.createTextNode("Proposal "), el("b", { class: "mono", text: proposal.id })]),
      el("li", {}, [el("a", { text: "Audit log", attrs: { href: `/audit?opportunity=${opportunityId}` } })]),
    ]),
  ];
  const notWritable = proposal.notWritable || [];

  if (proposal.fields.length === 0) {
    parts.push(el("div", { class: "empty-state" }, [el("p", { text: "The agent proposed nothing from this call. No empty field had evidence that passed the checks." })]));
  } else {
    parts.push(el("h2", { text: `Proposed from this call (${proposal.fields.length})` }));
    parts.push(...proposal.fields.map(renderField));
    const summary = waiting.length
      ? `${waiting.length} approved ${waiting.length === 1 ? "field is" : "fields are"} waiting to be written.${undecided.length ? ` ${undecided.length} still ${undecided.length === 1 ? "needs" : "need"} a decision.` : ""}`
      : written.length
        ? `${written.length} ${written.length === 1 ? "field" : "fields"} written to Salesforce.${undecided.length ? ` ${undecided.length} still ${undecided.length === 1 ? "needs" : "need"} a decision.` : ""}`
        : "Approve, edit or reject each field. Nothing is written until you choose to.";
    parts.push(
      el("div", { class: "applybar" }, [
        el("p", { text: summary }),
        el("button", {
          class: "primary",
          text: "Write approved fields to Salesforce",
          attrs: waiting.length ? {} : { disabled: "" },
          on: { click: () => call("/apply", {}) },
        }),
      ]),
    );
  }

  if (notWritable.length) {
    parts.push(el("h2", { text: "Not writable by the agent: forecast field, needs a manager" }));
    parts.push(
      el("p", {
        class: "muted",
        text: "The call says this changed. The agent asked the gatekeeper to update it and was refused. The manager approval flow is not built in this demo, so a manager makes this change in Salesforce.",
      }),
    );
    parts.push(...notWritable.map(renderNotWritable));
  }

  if (proposal.askNext.length) {
    parts.push(el("h2", { text: "Ask on the next call" }));
    parts.push(el("p", { class: "muted", text: "Empty in Salesforce, and this call gave no evidence for them." }));
    parts.push(el("ul", { class: "plain" }, proposal.askNext.map((f) => el("li", { text: f.label }))));
  }

  if (proposal.dropped.length) {
    parts.push(
      el("details", {}, [
        el("summary", { text: `Dropped by the checks (${proposal.dropped.length})` }),
        el("p", { class: "muted", text: "The model proposed these, and code set them aside before you saw them. Each drop is in the audit log." }),
        el(
          "ul",
          { class: "plain" },
          proposal.dropped.map((d) =>
            el("li", {}, [
              el("b", { text: d.label || "The whole model answer" }),
              document.createTextNode(`: ${d.reason}.`),
              d.value ? el("div", { class: "muted", text: `Proposed value: ${d.value}` }) : null,
              d.quote ? el("blockquote", { text: d.quote }) : null,
            ]),
          ),
        ),
      ]),
    );
  }

  parts.push(callBar(data.transcripts || []));
  app.replaceChildren(...parts);
}

call("");
