# Sistema de Pagos — instrucciones para Claude Code

@AGENTS.md
@docs/PLAN.md

## Prioridad

Si `AGENTS.md` y `docs/PLAN.md` se contradicen, **manda `docs/PLAN.md`**. Las invariantes de producto de `AGENTS.md` (regla especial de agosto, Google Sheets como almacenamiento, asignar solo al mes no VERIFICADO) quedan reemplazadas por la sección 3 del plan.

## Forma de trabajo

- Trabaja una sola fase del plan por sesión y por PR.
- Antes de escribir código, resume qué vas a cambiar y qué pruebas vas a agregar.
- Si una decisión de la sección 7 del plan hace falta, detente y pregunta.
- Ejecuta `npm run lint && npm run typecheck && npm test && npm run build` antes de terminar.
- Nunca imprimas en logs teléfonos, E/B/C, montos por casa, referencias ni nombres.
