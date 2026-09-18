# El número autorizado

Tesorero, administrador y cobrador viven en la tabla `usuarios`. De ahí sale quién puede
mandar el extracto del banco por WhatsApp y confirmarlo con un «SI».

## Una fuente, una copia

El teléfono autorizado se guarda en **un secreto del Environment**, y la fila de `usuarios`
es una copia que se sincroniza corriendo un workflow.

Esa es la parte importante: el secreto manda y la fila lo refleja. Sin esa regla el número
viviría en dos lugares con igual autoridad, y el día que cambie el tesorero el secreto diría
una cosa y la base otra sin que nadie se entere.

No está en una variable del código porque **este repositorio es público** y un teléfono es un
dato personal; y no está solo en la base porque cambiar de tesorero no puede necesitar entrar
a tocar filas a mano.

## Un solo secreto obligatorio

| Secreto | Obligatorio | Si no está |
|---|---|---|
| `PAGOS_USUARIO_TELEFONO` | **sí** | la corrida falla |
| `PAGOS_USUARIO_ROL` | no | `TESORERO` |
| `PAGOS_USUARIO_ID` | no | se deriva del rol: `u-tesorero` |
| `PAGOS_USUARIO_NOMBRE` | no | el identificador |

El nombre es opcional a propósito: no hace falta para nada y es un dato personal menos dando
vueltas. Los otros tres están por si algún día hace falta un segundo usuario.

## Cómo se corre

El workflow **Usuarios** (`.github/workflows/usuarios.yml`) es manual y **no tiene inputs**.
Los valores de un `workflow_dispatch` quedan a la vista en la página de la corrida, y ahí no
puede aparecer el teléfono de nadie (invariante 12). Los secretos, en cambio, Actions los
enmascara.

Pegás el número en `PAGOS_USUARIO_TELEFONO` y corrés el workflow desde Actions. Imprime una
de tres líneas y nada más:

- `Alta registrada con rol TESORERO.`
- `Actualizado el usuario con rol TESORERO.`
- `Ya estaba así. No se cambió nada.`

**Cambiar de tesorero** es cambiar el secreto y volver a correrlo: actualiza la misma fila,
así que el número anterior deja de estar autorizado en el momento. No quedan dos.

Si ese teléfono ya pertenece a **otra** persona del sistema, la corrida se niega y dice de
quién es. Elegir solos cuál gana sería quitarle el acceso a alguien sin que nadie lo pida.

## Dar de baja

`activo = 0` corta el acceso en el momento: `usuarioPorTelefono` no devuelve a un usuario
inactivo, así que sus mensajes vuelven a tratarse como los de cualquier vecino.

Ojo: volver a correr la sincronización **reactiva** al usuario. Correrla es decir «este es el
autorizado», y dejarlo inactivo contradiría eso en silencio.

## Qué puede hacer cada rol

| | Manda el extracto y lo confirma | Cobra efectivo |
|---|---|---|
| `ADMIN` | sí | — |
| `TESORERO` | sí | — |
| `COBRADOR` | **no** | sí |

El cobrador no concilia la cuenta. Darle las dos cosas sería darle la llave entera: registra
el cobro y después lo verifica él mismo.

## Esto no es lo mismo que `EXPECTED_BENEFICIARY`

Se parecen y no lo son:

| | Qué es | Contra qué se compara |
|---|---|---|
| `PAGOS_USUARIO_TELEFONO` | quién puede mandar el extracto | el remitente del mensaje de WhatsApp |
| `EXPECTED_BENEFICIARY` | el titular de la cuenta de cobro, **tal cual lo escribe el BAC** | el nombre impreso en el comprobante del vecino |

Hoy pueden ser la misma persona. No tienen por qué serlo, y el segundo tiene que coincidir
carácter por carácter con lo que imprime el banco, no con cómo se llama alguien.

## Un solo número es un solo punto de falla

Hoy el extracto llega de un número. Si ese teléfono se pierde o se clona, quien lo tenga
puede mandar un extracto falso, y el «SI» saldría del mismo teléfono comprometido.

Lo que hay contra eso está en `docs/EXTRACTO_BANCARIO.md`: la **cadena de balances** rechaza
un archivo editado a mano, que es la forma obvia de colar un depósito que no existió. No es
protección contra alguien que tenga el archivo real del banco y el teléfono, así que cuando
haya una segunda persona de confianza conviene darla de alta también — la tabla ya lo admite.
