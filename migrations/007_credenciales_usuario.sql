-- Cada persona entra con su propio usuario y su propia clave.
--
-- Hasta ahora el panel se abria con una sola clave compartida, y eso tiene dos
-- consecuencias que esta migracion viene a cerrar: `eventos` solo podia anotar
-- "panel" como actor —nunca quien—, y darle acceso al cobrador habria sido
-- darle tambien la capacidad de verificar transferencias y borrar viviendas.
--
-- Los roles ya existian en `usuarios` desde la 001. Lo que faltaba era como
-- identificarse.

-- El identificador que se escribe al entrar. Corto a proposito: el cobrador lo
-- teclea en un telefono, en la calle.
ALTER TABLE usuarios ADD COLUMN usuario TEXT;

-- scrypt, en el formato `N:r:p:sal:hash` (ver src/auth/claves.ts). Nunca la
-- clave en claro.
ALTER TABLE usuarios ADD COLUMN clave_hash TEXT;

-- Parcial: las filas sin usuario no compiten entre si. Un usuario dado de alta
-- por el workflow antes de esta migracion sigue siendo valido sin poder entrar.
CREATE UNIQUE INDEX ux_usuarios_usuario ON usuarios (usuario) WHERE usuario IS NOT NULL;
