# Dar de alta a una persona del sistema

Tesorero, administrador y cobrador viven en la tabla `usuarios`. De ahí sale quién puede
mandar el extracto del banco por WhatsApp y confirmarlo con un «SI».

## Por qué en la base y no en una variable

- **Este repositorio es público** y un teléfono es un dato personal.
- Cambiar de tesorero no puede necesitar un despliegue.
- El alta queda en `eventos`, que es donde se mira cuando hay que explicar por qué un
  extracto entró.

## Cómo se hace

El workflow **Usuarios** (`.github/workflows/usuarios.yml`) es manual y **no tiene inputs**.
Eso es a propósito: los valores de un `workflow_dispatch` quedan a la vista en la página de
la corrida, y ahí no puede aparecer el nombre ni el teléfono de nadie (invariante 12). Los
secretos, en cambio, Actions los enmascara.

1. En **Settings → Environments → `pagos-produccion`**, poné estos cuatro secretos:

   | Secreto | Qué va |
   |---|---|
   | `PAGOS_USUARIO_ID` | un identificador corto y estable, p. ej. `u-tesorero` |
   | `PAGOS_USUARIO_NOMBRE` | el nombre de la persona |
   | `PAGOS_USUARIO_ROL` | `ADMIN`, `TESORERO` o `COBRADOR` |
   | `PAGOS_USUARIO_TELEFONO` | el número de WhatsApp, con o sin `+` y guiones |

2. Corré el workflow **Usuarios** desde la pestaña Actions.
3. La corrida imprime `Alta registrada con rol TESORERO.` y nada más. Si ese teléfono ya
   estaba, dice que no cambió nada y no toca la base.

Para dar de alta a otra persona, cambiás los cuatro secretos y volvés a correrlo.

## Dar de baja

`activo = 0` corta el acceso en el momento, sin desplegar nada: `usuarioPorTelefono` no
devuelve a un usuario inactivo, así que sus mensajes vuelven a tratarse como los de
cualquiera.

## Qué puede hacer cada rol

| | Manda el extracto y lo confirma | Cobra efectivo |
|---|---|---|
| `ADMIN` | sí | — |
| `TESORERO` | sí | — |
| `COBRADOR` | **no** | sí |

El cobrador no concilia la cuenta. Darle las dos cosas sería darle la llave entera: registra
el cobro y después lo verifica él mismo.

## Un solo número es un solo punto de falla

Hoy el extracto llega de un número. Si ese teléfono se pierde o se clona, quien lo tenga
puede mandar un extracto falso, y el «SI» saldría del mismo teléfono comprometido.

Lo que hay contra eso está en `docs/EXTRACTO_BANCARIO.md`: la **cadena de balances** rechaza
un archivo editado a mano, que es la forma obvia de colar un depósito que no existió. No es
protección contra alguien que tenga el archivo real del banco y el teléfono, así que cuando
haya una segunda persona de confianza conviene darla de alta también — la tabla ya lo
admite.
