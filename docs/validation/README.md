# Validation documents

Sigil's own validation records, kept under version control so every change to a requirement or risk is tracked in git. Both files are drafts until reviewed and approved, then they are imported into Sigil's SRS and RISK trackers.

## srs-v1.csv: Software Requirements Specification (version 1)

| Column | Meaning |
|---|---|
| id | SRS-nnn, never reused |
| folder | Functional area (becomes a folder in the SRS tracker) |
| title | Short name |
| requirement | One testable "shall" statement |
| verification | Test (automated), Test (manual) or Inspection |
| rationale | Why the requirement exists |
| status | Draft, In Review or Approved |

## risk-v1.csv: Risk assessment (version 1)

Each RISK item names a way Sigil could fail, the requirements it relates to, and how that failure is mitigated and tested. Severity is the impact on the integrity of regulated records, not on convenience.

| Column | Meaning |
|---|---|
| id | RISK-nnn, never reused |
| title | Short name |
| linked_srs | Requirements whose controls mitigate this risk, separated by `;` (become "is mitigated by" links) |
| failure_mode | How Sigil could fail |
| effect | What the failure would do to the records |
| severity, likelihood | H, M or L |
| risk_level | From the matrix below: High, Medium or Low |
| mitigation | How the failure is prevented and tested |
| status | Draft, In Review or Approved |

| | Likelihood L | Likelihood M | Likelihood H |
|---|---|---|---|
| **Severity H** | Medium | High | High |
| **Severity M** | Low | Medium | High |
| **Severity L** | Low | Low | Medium |

Risk level sets test depth:
- **High:** automated positive and negative tests, including attempts through the API, with evidence kept for every run.
- **Medium:** automated tests of the main paths and key failure cases.
- **Low:** basic automated or manual test.

The approach follows risk-based practices in GAMP 5 and FDA's Computer Software Assurance guidance. Sigil follows Part 11 practices; it is not certified as compliant.

## Importing into Sigil

Use **Import CSV** on the tracker page (SRS first, then RISK, so the RISK links can find their requirements). Each requirement's `requirement` text becomes numbered ERs, one per line (lines starting with `-` stay inside the ER above), and each imported requirement gets its test case (SRS-011 ↔ TC-011), ready for its steps. Sigil shows a preview with every row's validation errors before anything is created, and creates nothing unless every row is valid. The `id` column must match the ID Sigil will assign, so importing into a tracker that already has items, or importing the same file twice, is refused rather than creating duplicates. Imported items start in New whatever the `status` column says; approval happens in Sigil, with signatures.
