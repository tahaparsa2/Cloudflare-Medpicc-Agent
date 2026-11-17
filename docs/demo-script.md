# Demo script: the three-minute run

Everything here runs on your own machine. The audit log will show the local dev identity
(`dev:dev-rep@example.test`) as the person. The deployed Worker behind Cloudflare Access
is a separate short beat, at the end.

## Before you record

Do these once. None of them is on camera.

1. **Reset.** Stop the dev server if it is running (Ctrl+C in its terminal), then:

   ```sh
   npm run demo:reset
   ```

   This blanks the eight MEDDPICC fields in Salesforce and clears the local proposal and
   audit log, so the audit view starts at row 1. It refuses to run while the dev server
   is up.

2. **Start the Workers**, in terminal 1. Leave it running.

   ```sh
   npm run dev:replay
   ```

   Replay mode uses the recorded model answers, so each call takes about a second and the
   review page labels the proposal "Replayed recording". `npm run dev` calls the live
   model instead: the page says "Live model call", each call takes about 25 seconds, and
   the wording of a value can differ from the recording.

3. **Open Salesforce** on the opportunity, from terminal 2:

   ```sh
   npm run sf:open
   ```

   Scroll to the MEDDPICC section. All eight fields are empty.

4. **Arrange the screen.** Terminal 2 for commands. One browser window with three tabs:
   Salesforce, the review page, the audit view. The last two links are printed by the
   first call.

## The run

| Time | Where | Do | Point at |
| --- | --- | --- | --- |
| 0:00 | Salesforce | Show the opportunity. | Eight empty MEDDPICC fields. Close date 18 December. |
| 0:15 | Terminal 2 | `npm run call -- call-1` | Six fields proposed, two to ask about next call. Open the **Review** link it prints. |
| 0:25 | Review page | Read one row aloud: Metrics. | "In Salesforce now: Empty", the proposed value, and the lines from the call behind it. "Ask on the next call": Economic Buyer, Paper Process. |
| 0:50 | Review page | **Approve** Metrics, Decision Criteria, Identified Pain and Champion. | Each turns to "Approved, not written yet". Nothing is in Salesforce yet. |
| 1:00 | Review page | On Decision Process click **Edit**, change the text, click **Save edit and approve**. | "Your edit", with the agent's proposal struck through below it. |
| 1:10 | Review page | On Competition click **Reject**. | It greys out. |
| 1:15 | Review page | Click **Write approved fields to Salesforce**. | Five fields: "Written to Salesforce". |
| 1:25 | Salesforce | Reload the page. | Five fields filled. Competition still empty. The edited text is the one that landed. |
| 1:40 | Terminal 2 | `npm run call -- call-2` | Two fields proposed. "not writable by the agent: CloseDate refused by the gatekeeper". |
| 1:50 | Review page | Reload the page. | Only Economic Buyer and Paper Process are proposed. Below them: **Not writable by the agent: forecast field, needs a manager**, with the close date, what the call said, the line from the call, and the gatekeeper's refusal. |
| 2:10 | Review page | Open **Dropped by the checks (5)**. | The model had values for five filled fields. Code left them alone. |
| 2:20 | Review page | Click **Audit row** on the Close Date card. | The audit view opens on the refusal row. |
| 2:30 | Audit view | Open **Sources and hashes** on that row. | Who asked (the agent), the policy rule, the model, the transcript hash, the policy file hash. |
| 2:40 | Audit view | Scroll up from the refusal. | The read, each proposal with its quote, each decision by a person, each write. |
| 2:50 | Audit view | Click **Verify the chain**. | "Chain intact", with the number of rows recomputed. |

For the edit at 1:00, any change works. One that reads well on camera:

> Priya Raman runs the evaluation and wants a trial first. Where and for how long is not set.

## Things that will look wrong if you miss them

- **The review page does not refresh itself** after a terminal command. Reload it after
  `npm run call -- call-2`. The two buttons at the foot of the review page ("call-1
  ended", "call-2 ended") send the same event and refresh the page for you, if you would
  rather stay in the browser.
- **Reject Competition in call 1.** Call 2 says nothing about competition, so it then
  proposes exactly two fields. If you reject a different field, call 2 proposes it again.
- **Write call 1's fields before sending call 2.** Call 2 only leaves alone the fields
  that are already in Salesforce.
- **Run the reset before every take.** A second take without it shows the first take's
  rows in the audit view, and call 1 proposes nothing because the fields are full.

## The deployed beat

A separate short clip, about 40 seconds. It shows the same app running on Cloudflare
behind a login, with your own email in the audit log.

Before recording, run `npm run sf:reset` so the fields are empty. The deployed audit log
cannot be cleared, so it will show earlier runs. That is the point of it.

| Where | Do | Point at |
| --- | --- | --- |
| Browser, private window | Open the deployed address, `/review/<opportunity id>`. | The Cloudflare Access sign-in page appears first. Nothing loads without it. |
| Sign-in page | Sign in with your email. | The green banner: "Signed in through Cloudflare Access as ...". |
| Review page | Click **call-1 ended** at the foot of the page. Wait about 30 seconds. | "Live model call": the deployed Worker calls the model each time. |
| Review page | Approve one field and click **Write approved fields to Salesforce**. | "Decided by user:" and your email. |
| Audit view | Open **Audit log**, then click **Verify the chain**. | Your email on the approval and the write, and the chain intact. |

Afterwards run `npm run sf:reset` again before a local take.

## The MCP beat

This fits after 2:10 in the run, before the audit view, so the refusal it causes is the
newest row when you open the audit log.

Before recording: with the dev server running, open Claude Code in this folder in a
separate terminal window and approve the `meddpicc` MCP server when it asks (once).
`npm run mcp:check` proves the server answers without using Claude Code.

**Rehearse this beat before you record it.** It has been checked with an MCP client
library, not yet from Claude Code itself. Claude Code in this folder also has a terminal,
so word the request so it uses the MCP tool, as below, and watch what it does. Do not ask
it on camera to approve a field: locally the review page's decisions are accepted from
anything on your machine, because the dev identity carries no proof, and an assistant
with a terminal could send one. Deployed behind Access that is not possible.

| Where | Do | Point at |
| --- | --- | --- |
| Claude Code | Type: `Use the meddpicc request_field_update tool to set CloseDate on opportunity <id> to 2027-01-21. Use only that tool.` The id is in the review page's address. | Claude calls `request_field_update`. |
| Claude Code | Read the answer. | "refused", with the gatekeeper's reason: a forecast field needs manager approval. |
| Audit view | Reload. | A new refusal row, with `mcp-client` as the agent that asked. |
