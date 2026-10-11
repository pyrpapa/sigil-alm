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
