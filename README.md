# Ludo Gigante (multijugador)

Ludo en un tablero de 19×19 con 68 casillas de recorrido, para 2 a 4 jugadores en línea.
Cada jugador entra desde su celular o computadora; pueden existir varias salas a la vez.

## Cómo funciona

- **Crear sala**: te da un código de 4 letras y un enlace para invitar (`/?sala=ABCD`).
- **Salas públicas**: aparecen en la lista de inicio para que otros se unan.
- **Asientos**: cada color es un asiento. El anfitrión puede agregar CPU, quitar CPU o expulsar jugadores.
- **Partida**: el servidor lleva todas las reglas (dado, capturas, turnos), así que nadie puede hacer trampa.
- **Desconexiones**: si alguien se cae, su turno lo juega el servidor y puede volver a entrar a la misma partida.
  Si no juega en 40 segundos, el servidor juega por él; tras 3 turnos así lo reemplaza una CPU.

## Probarlo en tu computadora

Necesitas Node.js 18 o superior.

```bash
npm install
npm start
```

Abre http://localhost:3000. Para probar con varios jugadores, abre el enlace de la sala en otra pestaña o ventana privada.

## Subirlo a internet

Hace falta un hosting que ejecute **un proceso Node con WebSockets**. No sirven los hostings solo de archivos estáticos
(GitHub Pages, Netlify estático) ni las funciones serverless (Vercel).

Ejemplo con Render (plan gratuito):

1. Sube esta carpeta a un repositorio de GitHub.
2. En render.com: **New → Web Service** y elige el repositorio.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Cuando termine, Render te da una dirección `https://...onrender.com`. Compártela: ya es tu juego en línea.

Railway, Fly.io o cualquier VPS funcionan igual (`npm install` y `npm start`).
El servidor usa la variable `PORT` que le entregue el hosting, y el cliente se conecta solo con `wss://` si la página es `https://`.

## Límites a tener en cuenta

- Las salas viven en la memoria del servidor: si el servidor se reinicia, las partidas en curso se pierden.
- Debe correr una sola instancia (no varias copias a la vez), porque las salas no se comparten entre procesos.
- En el plan gratuito de Render el servicio se duerme tras un rato sin visitas; la primera carga puede tardar medio minuto.
- Hay un máximo de 300 salas simultáneas (`MAX_ROOMS` en `server.js`).

## Archivos

- `server.js`: servidor HTTP + WebSocket, salas y reglas del juego.
- `public/index.html`: toda la interfaz (inicio, sala de espera y tablero).
- `/healthz`: responde `{ok:true,...}`, útil para el monitoreo del hosting.
