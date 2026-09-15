# PAGOS project instructions

## Identity

- Repository: `sistemas-pagos/Sistema-Pagos` (standalone).
- PR title prefix: `[PAGOS]`.
- Branch prefix: `pagos/`.
- CI workflow: `.github/workflows/ci.yml`.

This project was extracted from the `Jchernand3z19/Portafolio` monorepo with its history intact. Monorepo scope rules, `project-scopes.yml` and sibling-project boundaries no longer apply: every path in this repository belongs to PAGOS.

## Product invariants

- Housing identity is **Etapa + Bloque + Casa**. Never infer housing from a WhatsApp phone number or depositor name.
- If any of Etapa/Bloque/Casa is missing or invalid, ask the same WhatsApp conversation for all three using `E1 B4 C18` and update the existing payment without repeating OCR.
- The WhatsApp sender number is private conversation/payment metadata only. It is not stored in the housing master and never decides the home.
- The expected bank-payment amount for the current MVP is **L150.00**. Any amount below or above L150 is preserved but sent to human review; never silently normalize it to a normal monthly fee.
- August 2026 is the historical baseline: deposits dated Aug 1-14 map to July; Aug 15-31 map to August. From September onward, assign the oldest service month not yet **VERIFICADO** starting at August. A merely received/review receipt does not advance the ledger. Never silently advance an extra payment beyond its deposit month.
- A home counts as paid only after its payment for that service month is `VERIFICADO`; keep received and verified money separate in accounting/dashboard semantics.
- A bank reference is a matching/risk signal, not a globally unique payment identifier. Repeated references go to review unless a stronger exact-duplicate signal exists.
- Meta retries with the same `message_id` are idempotent and silent. Exact file resends are duplicate signals. Cross-sender exact-file reuse goes to review.
- Receipt images are **not retained** in the current MVP. Download bytes only for validation/hash/OCR/parser during the request, persist the SHA-256 and structured payment data, and discard the image. Do not persist `media_id`, `receipt_file_id`, Drive/Blob/S3 copies, or public/private receipt URLs unless the client explicitly changes this policy later.
- `RECIBIDO/PENDIENTE_VERIFICACION` is distinct from `VERIFICADO`. A human bank check or a future trusted bank-side reconciliation source is required for verification.
- Manual verification must not bypass unresolved amount exceptions, service-period conflicts, or evidence that the same bank movement is already claimed/reused.
- Future automated reconciliation must require a stable bank-side movement identifier and persist it so the same movement cannot verify more than one payment across runs.
- Public demo fixtures must be entirely synthetic. Never commit real receipts, phone numbers, banking data, credentials, service-account files, or secrets.

## Data and security

- Production Google Sheets remains private and server-side; Google Drive is not required while receipt retention is disabled.
- WhatsApp webhook signature validation and file type/size/magic-byte validation must remain fail-closed.
- Never put Meta/Google/BAC credentials in Git, docs, fixtures, logs, screenshots, or public demo output.
- Preserve production/preview separation. Repository secrets belong to this project only: `WHATSAPP_*`, `META_*`, `PAGOS_*`, `GOOGLE_SHEETS_*`.

## Validation

Run the project checks from the repository root before pushing: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. CI runs the same four steps on every pull request and on `main`.
