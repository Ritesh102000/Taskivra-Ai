# Task readiness and reusable workflow inputs

Implemented first slices of F02 and F06. Readiness checks only capabilities declared by the selected workflow and its pinned input slots. A configured model key is not described as a tested connection. Checks make no paid model requests and do not read mail, start containers, or attempt website login. Native Chrome readiness does not require Docker. A live Gmail or Google import requirement also needs the exact owner-approved project account. Pinned PDF/XLSX inputs require the isolated document image and exact parser versions; missing, corrupt or oversized documents direct the owner to Files. Already imported snapshots do not require a live Google connection. Safe actions open the relevant setup view.

The six starter jobs have immutable, content-addressed procedure definitions. The CSV comparison starter requires two explicitly assigned CSV versions, with valid headers and at least one data row; it does not invent business-specific column names. Each CSV is capped at 1 MiB and 10,000 rows. Its output contract is one report with findings, coverage, calculation checks, limitations, and reproducible code. Example output is labelled as illustrative.

A task stores the exact procedure definition used to create it. Saved jobs can preserve named parameters and the output contract without copying previous account grants, file assignments, input values, credentials, or messages. Existing manual-brief saving remains available. Unsaved composer values survive navigation to setup during the current application session; quitting the application clears that temporary draft.

Required file assignments must reference versions already pinned as task inputs. The service verifies accessibility, immutable bytes, format, size, and content constraints. Admission rechecks are required both when starting and when a worker claims the task, so scheduling or resuming cannot bypass missing inputs. Invalid inputs direct the owner to Files before model work. Assignments can change only while the task is paused or waiting and has no running execution.

## Integration

- `WorkflowService.readinessRequirements(target)` resolves task or workflow draft requirements.
- `requirementsForTask(taskId)` reads the stored procedure snapshot.
- `assertInputsReady(taskId)` enforces required slots; ordinary manual tasks remain unaffected.
- `inputContext(taskId)` returns safe named-slot/version identifiers for the model context.
- `workflows.assignInputs` accepts only `{taskId, assignments: [{slotKey, versionId}]}`; it accepts no paths or credentials.
- `ReadinessService` consumes injected read-only model, browser, code, Gmail, and requirements ports. It does not infer past successful authentication from unrelated keys.
- `ReadinessPanel` accepts already-pinned input versions and safe navigation callbacks.

Schema version 9 adds nullable procedure snapshots to saved workflows and task origins, plus `workflow_input_assignments`. Old manual workflows keep their behavior.

## Verification and boundaries

24 focused readiness/workflow-input tests passed, including exact-account setup, optional capability isolation, native-browser readiness, missing input rejection, CSV validation, private-version scope, immutable definitions, manual compatibility, and explicit detailed-mail opt-in without copying the grant to a named saved procedure. Type checking passed. Tests use temporary data and mocked status ports; they do not prove Google authentication or paid model execution. Product demand and market fit remain validation hypotheses.
