# PAGOS project instructions

## Identity

- Repository: `sistemas-pagos/Sistema-Pagos` (standalone).
- PR title prefix: `[PAGOS]`.
- Branch prefix: `pagos/`.
- CI workflow: `.github/workflows/ci.yml`.

This project was extracted from the `Jchernand3z19/Portafolio` monorepo with its history intact. Monorepo scope rules, `project-scopes.yml` and sibling-project boundaries no longer apply: every path in this repository belongs to PAGOS.

## Product invariants

These are the invariants of `docs/PLAN.md` section 3, which is the source of truth for
this project. When this file and the plan disagree, the plan wins.

1. Housing is never inferred from the phone number or the depositor's name.
2. **Received is not verified.** A home counts as paid only with a `VERIFICADO` payment
   (transfer) or `EFECTIVO_COBRADO`/`VERIFICADO` (cash).
3. A transfer is verified only against a movement from the bank CSV. One movement verifies
   exactly **one** payment (UNIQUE constraint).
4. Beneficiary and the last 4 digits of the destination account are **mandatory** in
   production, compared exactly after normalising. No match, `RECHAZADO` (another account).
   Unreadable, `EN_REVISION`.
5. Month assignment: the oldest month since the home's registration date with no
   `VERIFICADO` payment **and not reserved by a pending one**. `NO_ENCONTRADO`, `RECHAZADO`
   and `ANULADO` release the month. Never assign future months.
6. An amount that is an exact multiple of the current fee is split across overdue months
   (never future ones). Any other amount goes to `EN_REVISION`.
7. Money is stored in **whole cents**.
8. Nothing is overwritten without an event: every correction writes to `eventos` (who,
   before, after, reason). `eventos` can be neither edited nor deleted.
9. A closed month is not modified; corrections enter as an adjustment in the next month.
10. Receipt number: a single global sequence, never reused. One receipt per payment. It is
    voided with a reason and reissued, never edited.
11. Receipt images are not kept. `media_id` is stored only until the message is processed,
    then deleted.
12. This repository is public: Actions logs **never** show phone numbers, Etapa/Bloque/Casa,
    per-home amounts, references or names. Never upload artifacts containing data.
13. Messages to a resident outside the 24 h window use **approved** WhatsApp templates.
14. Meta retries with the same `message_id` are ignored. Permanent errors are marked
    `RECHAZADO` and the resident is told; never return 500 for a permanent error.

Public demo fixtures must be entirely synthetic. Never commit real receipts, phone numbers,
banking data, credentials, service-account files or secrets.

## Data and security

- Turso is the single source of truth (`docs/PLAN.md` section 1). Google Sheets is a
  read-only destination for dashboards and listings; it stops being storage in phase 7,
  so `src/storage/google-sheets.ts` is still in use until then.
- Production Google Sheets remains private and server-side; Google Drive is not required while receipt retention is disabled.
- WhatsApp webhook signature validation and file type/size/magic-byte validation must remain fail-closed.
- Never put Meta/Google/BAC credentials in Git, docs, fixtures, logs, screenshots, or public demo output.
- Preserve production/preview separation. Repository secrets belong to this project only: `WHATSAPP_*`, `META_*`, `PAGOS_*`, `GOOGLE_SHEETS_*`.
- Turso credentials live in the `pagos-produccion` Environment as `PAGOS_TURSO_URL` and `PAGOS_TURSO_TOKEN`. Never in code, logs or fixtures.

## Validation

Run the project checks from the repository root before pushing: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. CI runs the same four steps on every pull request and on `main`.

The scripts under `scripts/` are run in Actions with `npx tsx`, not with bare `node`: they
import through the `@/` alias and without file extensions, which Node's loader does not
resolve. `tests/scripts-arrancan.test.ts` starts each one to keep the four checks above from
passing while a workflow is broken.

Database migrations live in `migrations/NNN_*.sql` and are applied only by the manual
`migraciones` workflow. An applied migration is immutable: to change the schema, add a
new file.
