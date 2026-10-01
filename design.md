# Agent Workspaces — product and interface design

Planning baseline: 11 September 2026. Companion to [architecture](architecture.md) and [implementation plan](implementation-plan.md). The accompanying interactive preview is a design simulation; it does not upload files, contact models, or run agents.

## 1. Product experience

The user creates an agent, assigns a task, and follows its work in one place. The agent works across its browser tabs and private files, runs code when needed, and asks specific questions when it cannot proceed. A shared library and activity feed connect the agents' work without exposing every private conversation.

The interface should answer four questions immediately: **What is working? What needs me? What was produced? Who can access it?**

## 2. Application shell

Use a compact native-feeling Mac window with three regions:

- **Left navigation:** All tasks, Requests, Shared library, then the agent list. Each agent shows a name and its current task status. Settings stays at the bottom.
- **Main panel:** Selected task title, agent, current state, conversation, input requests, and final outputs.
- **Work panel:** Browser, Files, and Activity views for the selected agent/task. This panel is resizable and can collapse on a small window.

Keep the selected agent and task visible while switching work views. Do not show invented percentage completion for open-ended tasks. Show concrete progress such as “Opened two source pages,” “Waiting for the previous-period file,” and “Comparison script finished.”

Use a restrained neutral palette, one accent for the selected action, and text labels alongside status colors. Support light/dark appearance, keyboard access, readable file names, selectable activity output, and a reduced-motion setting. At narrow widths, move the work panel below the conversation or expose one view at a time.

## 3. Screens

| Screen | Main content | Primary actions |
|---|---|---|
| Setup | Container runtime, runtime images, model connection, data location, limits | Check setup; choose data folder; connect provider |
| All tasks | Queued, running, waiting, completed tasks with agent ownership | New task; open a task; filter by state |
| Agent workspace | Instructions summary, task conversation, work panel | Assign task; attach files; pause; stop |
| Requests inbox | Outstanding file slots, questions, handoffs, and which task needs them | Supply files; answer; open browser |
| Shared library | Versioned artifacts, producer, description, consumers | Add shared file; preview; use in task |
| Shared activity | Shareable task changes, published files, agent handoffs | Open source task; open exact artifact version |
| Settings | Models, data/storage limits, containers, agent permissions, session reset | Update configuration; export history; clear selected session |

### Setup details

Show an actionable state for each dependency: ready, missing, stopped, or failed. The app checks Apple Silicon runtime compatibility, available memory/storage, browser sandbox startup, code isolation, and model connectivity before enabling live tasks. Images download only as a deliberate setup action; show expected size when known.

Provider credentials are entered in a dedicated setup surface and saved in the OS credential store. State that cloud requests may contain task text, selected file content, and page images. Configure a spend cap and useful task limits during setup.

## 4. Creating agents and tasks

Agent form: name, instructions, default model, browser permission profile, code runtime, and limits. The workspace/session is created automatically. User-created agents are sufficient for the MVP; autonomous spawning is deferred.

Task form: desired outcome, assigned agent, attachments, optional references to shared artifacts, and completion criteria. A task can explicitly authorize publishing a named output or sending it to another agent. Advanced options may add a dependency on another task.

New local uploads default to **Private to this agent**. A separate “Share with all agents” choice is visible when the user wants broader access. Do not infer sharing from the existence of a global folder.

## 5. File request interaction

The request card is the same object in chat and the Requests inbox. It always names the agent and task.

```text
Agent A · Compare the two periods
Waiting for files

I need both source files to calculate the comparison.

Current period     [ current.csv · Accepted ]
Previous period    [ Choose file ] [ From shared library ]

Files go to Agent A. Sharing: Private.
1 of 2 required files accepted.
```

Allow native file selection, drag-and-drop onto a slot, and selecting existing permitted artifacts. If several files are dropped on a request, show a mapping step instead of guessing which slot each fills. Display file name, size, validation status, and remove/replace actions.

States and copy:

| State | What appears |
|---|---|
| Missing | “Choose the previous-period file” |
| Uploading | Actual byte progress and cancel action |
| Checking | “Checking file format and required columns” |
| Accepted | Filename plus check label |
| Needs replacement | Specific issue, such as “This file contains the current period; the previous period is still needed” |
| Request fulfilled | “Files accepted. Task queued to continue” |
| Task resumed | Agent acknowledgment naming the inputs it will use |

Keep accepted slots intact when another upload fails. The user should not need to re-upload everything. A completed transfer is not the same as a usable file.

If the user cannot provide a file, expose **I don't have this file** with a text response. The agent can propose a reduced outcome; it must not fabricate the missing data. Optional attachments never prevent continuation.

For a cancelled task, the request shows “Task cancelled” and cannot resume it. Reusing its files requires an explicit new task or restart action.

## 6. Browser panel

Show the actual agent session's tab titles, current URL, loading/error state, selected page view, and controller. The user can add/select/close tabs through the owner interface. Model browser actions address the same session through the broker.

**Controller: Agent** → **Take control** → **Controller: You** → **Return to agent**.

Taking control first pauses agent browser commands. During login, the page remains visible to the user, but its frames and keystrokes are excluded from model observations and persistent traces. The task conversation receives only status updates. On return, the agent re-observes the current page.

If an action is already underway, show “Finishing current browser action” before claiming the handoff is complete. Do not show both controllers as active. A browser worker crash shows **Reconnecting session** or **Login required**, not an old screenshot presented as live.

Downloads become private files with a link to the originating tab. Uploads to a website show the selected artifact and destination in activity; only authorized task uploads proceed. The file chooser is mediated by the broker.

The initial viewer supports page interactions. Native dialogs, device passkeys, local certificate prompts, and OS-integrated SSO remain compatibility cases to verify in Phase 0.

## 7. Files and shared library

Private files are grouped into Inputs, Work, and Outputs in the product. The shared library contains only published versions or owner-shared imports.

Artifact details: name, type, version, producer agent/task, source inputs, visibility, creation time, preview, and download/export. Internal checksums and storage IDs can stay in technical detail.

Actions: **Use in task**, **Publish to shared library**, **Create derived copy**, **Export**. Publishing prompts for a useful description when one is not available. If the task already authorizes publishing that output, the agent can publish directly and the user sees an activity item.

Two `report.csv` files must remain distinct. A newer version never silently changes the input of a running task. Show “New version available” with an explicit use/update action.

For mixed private/shared inputs, derived output defaults to private unless the task's sharing grant covers it. Agent messages use the same sharing rule.

## 8. Code and activity panel

Present code execution as a readable activity item:

```text
Process source files                     Completed
Runtime: Python                         Duration: 3.2 s
Command: python work/compare.py
Working directory: /workspace

Loaded two files. Wrote comparison.csv.
Exit code: 0

Outputs: comparison.csv [Preview] [Use in task]
```

This is an illustrative state, not a performance benchmark. The app records actual duration and status.

A running job has **Stop execution**. Show stdout/stderr, exit code, generated artifacts, and whether workspace changes were saved. An interrupted export must not appear as a committed workspace update.

Memory/time/storage limits produce specific messages and retain the last committed workspace. Missing packages produce a dependency request, not a generic failure or silent network access. Larger runtime/network allowances are owner settings, not implementation details forced into every task conversation.

The normal conversation explains what the job accomplished. Expandable activity contains commands and technical detail.

## 9. Agent collaboration experience

Example workflow, chosen only to demonstrate the system:

1. User gives Agent A a browser research and file-processing task and authorizes sharing its resulting dataset.
2. Agent A opens two source tabs, asks the user for a missing CSV, and waits.
3. Agent B continues its independent task in another browser session.
4. The user supplies the CSV; Agent A validates it and runs a script in its code container.
5. Agent A publishes an immutable dataset version.
6. Agent B receives a concise event with the dataset description and version reference.
7. Agent B reads that version, produces its own result, and links back to the source.

The shared activity feed shows task ownership, waiting/completion, publications, and handoffs. Private task text is summarized according to its sharing policy. Agents discover relevant work through scoped events and queries, not by scanning all private folders.

## 10. Feedback, notifications, and edge states

- Desktop notifications: file/input needed, login needed, completed outcome, actionable failure. Avoid a notification for every click or script line.
- Pause: “Paused at a checkpoint.” If not yet paused, show “Pausing.”
- Stop: “Stopping current work.” Then distinguish stopped jobs from any external action already submitted.
- App closed or Mac asleep: tasks resume only when the local app/runtime can run again. Do not promise execution while the Mac sleeps.
- Model unavailable: show retry timing within the configured limit, then a recoverable error.
- Upstream task failed: show the dependency and keep downstream work waiting; allow reassignment or a revised requirement.
- Browser submission outcome unknown: explain what is known and what must be checked before retrying.
- Empty workspace: show a New task action and a short description of the three available tools: browser, files, and code.

## 11. Interaction acceptance

The owner can always identify the recipient of an upload, the controller of a browser session, the visibility of an artifact, and the current blocker of a task. Request cards and inbox state stay synchronized. Actions are keyboard-accessible, states have text labels, and errors explain a next step.

The design preview illustrates partial file fulfillment, browser takeover, execution activity, and the shared library using fixed sample data. It is not a working product or evidence that the architecture has been implemented.
