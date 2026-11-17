# Cash Out · España

Luiza Prado, 2026

[Español](#español) · [English](#english)

## Español

Cash Out · España sigue el dinero que se apuesta en Polymarket, un sitio de apuestas que funciona con criptomonedas, sobre las elecciones generales de España del 29 de noviembre de 2026. Cada hora, hasta el cierre de las urnas, el proyecto registra todas las apuestas de las 24 horas anteriores en el mercado «Spain General Election Winner» (qué partido gana más escaños) y las convierte en una imagen marmolada, una gota de tinta por apuesta. Se guarda una imagen por hora.

Es la segunda edición de [Cash Out](https://github.com/lll-uuu/cash-out), que siguió el dinero apostado en la segunda vuelta presidencial de Brasil.

**¿Quién especula sobre nuestros futuros?**

España bloqueó Polymarket en mayo de 2026 por operar sin licencia de juego, pero cualquier persona con una billetera de criptomonedas puede seguir apostando sobre quién va a gobernar el país, desde cualquier lugar del mundo y sin identificarse. Este proyecto busca entender cómo circula el capital en los enredos contemporáneos entre poder colonial y tecnología: de quién es el dinero que mueve las probabilidades de una elección española, cuándo se mueve y de dónde viene. Y una pregunta nueva, que viene de la edición brasileña: ¿aparecen las mismas billeteras, del mismo lado, en elecciones de distintos países donde crece la extrema derecha?

**Qué datos genera y dónde quedan.**

Todo viene de fuentes públicas: los datos abiertos de Polymarket y la blockchain Polygon, donde queda registrada cada apuesta. No se recoge nada de quien visita la página. Todo queda guardado en este repositorio público:

- `data/snapshots/`: un archivo por hora, con las probabilidades y todas las apuestas de las 24 horas anteriores (hora, dirección de la billetera, monto, a favor o en contra de qué partido, y código de la transacción), además de las apuestas fuera de lo común: ballenas, billeteras nuevas y giros en las probabilidades.
- `frames/`: la imagen hecha cada hora.
- `data/index.json`: un resumen de una línea por hora.
- `analysis/`: un análisis agregado, hecho una vez al día. Nunca identifica billeteras; solo muestra números sobre grupos.

### Cómo leer la imagen

| En la imagen | Viene de |
|---|---|
| Tinta roja | Apuestas al PSOE (comprar su «sí» o vender su «no») |
| Tinta azul | Apuestas al PP |
| Tinta verde | Apuestas a Vox, en el verde del propio partido |
| Tinta gris, apagada | Apuestas *en contra* de un partido (comprar su «no» o vender su «sí»). Conservan un rastro del color del partido |
| Tinta blanca y crema | Apuestas de US$ 1.000 o más de ballenas (billeteras que apuestan US$ 5.000 o más en menos de una hora) o de billeteras nuevas (usadas por primera vez menos de 7 días antes). El borde tiene el color de lo que apostaron. Arremolinan la tinta alrededor |
| Dónde cae la tinta de una billetera | Dígitos 1 a 4 de la dirección (horizontal) y 5 a 8 (vertical) |
| El tono exacto | Dígitos 9–10 de la dirección definen el matiz, 11–12 la saturación, 13–14 el brillo, 15–16 la opacidad |
| Cuánta tinta | El monto apostado: más gotas y gotas más grandes, con anillos en las apuestas grandes |
| Arrastres de peine | Uno por hora. Cada partido arrastra la tinta en su propia dirección, con la fuerza de sus probabilidades: el PSOE en vertical, el PP en horizontal, Vox en diagonal. Un partido con 1% casi no mueve el baño; el favorito lo arrastra todo |
| Gotas redondas encima | Las dos últimas horas, todavía sin peinar |
| Arrastres en ramillete | Un giro de 3 puntos o más en las probabilidades de un partido en una hora |
| Puntos negros | Los códigos de las transacciones, uno o dos por apuesta |
| El fondo | El pUSD, la moneda digital de Polymarket (`0xC011a7…`), llevado casi al negro |

**Sobre las apuestas «en contra».** Con tres partidos, apostar en contra de uno no es apostar a favor de otro, así que esas apuestas tienen su propia tinta. Ojo: comprar el «no» de un partido que casi no tiene opciones (Vox, para ganar más escaños) cuesta casi un dólar y paga un poco más. Es sobre todo una forma de cobrar un pequeño rendimiento, no una posición política. Por eso habrá mucho gris «contra Vox». Las apuestas *a favor* de Vox son las que van contra las probabilidades.

Los límites (monto de una ballena, edad de una billetera nueva, etc.) están en `lib.js`. Una segunda paleta, `contracts`, se puede generar con los mismos datos usando `--palette contracts`.

### Cómo instalarlo (unos quince minutos)

1. Creen un repositorio nuevo en GitHub, por ejemplo `cash-out-espana`. Público es lo más simple: los minutos de Actions son gratuitos y Pages funciona en el plan gratuito.
2. Suban todo lo que está en esta carpeta, incluida la carpeta oculta `.github`, a la rama `main`.
3. Abran **Actions**, activen los workflows si se lo pide, elijan **Cash Out España hourly** y hagan clic en **Run workflow** una vez. Aparece un primer archivo en `data/snapshots/` y en `frames/`.
4. Una sola vez: elijan **Cash Out España backfill** y hagan clic en **Run workflow**. Trae las apuestas de las semanas anteriores (el mercado abrió el 5 de octubre) como una instantánea por día, para que el análisis cubra toda la campaña. La API solo devuelve una cantidad limitada de apuestas hacia atrás; el registro del workflow dice hasta qué fecha llegó.
5. Para la página: **Settings → Pages → Deploy from a branch → main / (root)**. La página muestra la hora más reciente y se actualiza sola. Al pasar el mouse sobre la imagen, muestra de qué billetera es la tinta.
6. Opcional, para la sección sobre el origen del dinero: una clave gratuita de Etherscan (etherscan.io → API Keys), guardada como secret del repositorio con el nombre `ETHERSCAN_API_KEY` (Settings → Secrets and variables → Actions).

El workflow corre cada hora en punto. La última imagen es la de las 20:00 UTC del domingo 29 de noviembre (21:00 en Madrid), cuando cierran las urnas en Canarias, las últimas del país. GitHub suele empezar las ejecuciones programadas unos minutos tarde y a veces se salta alguna; cada imagen queda registrada en su hora.

Para generar una imagen más grande de cualquier hora, en una computadora con Node 20: `npm install` y luego `node render-frame.js data/snapshots/<hora>.json --size 4000 --format png --out grandes`. Para ver la página con datos de prueba (no reales), sin red: `npm run sample`, `node render-frame.js data/sample.json --out /tmp/prueba` y `node scripts/build.js --embed data/sample.json --frame /tmp/prueba/2026-11-17T15Z.jpg --out /tmp/preview.html`.

### Análisis agregado

`analyze.js` corre una vez al día (workflow **Cash Out España analysis**, o `npm run analyze`) y escribe en `analysis/`:

- `informe.md`: un informe en español: quién apuesta y a qué lado, día a día, horarios en hora de Madrid, dinero puesto antes de los giros, husos horarios estimados, edad de las billeteras, en qué más apuestan, de dónde vino el dinero y un **cruce con Cash Out Brasil**: cuántas de las billeteras que apuestan sobre España también apostaron en la elección presidencial de Brasil, y si ese dinero fue a Flávio Bolsonaro o a Lula, agrupadas según lo que respaldan en España (incluido un «bloque derecho»: PP, Vox o contra el PSOE).
- `hourly.csv`: cada hora registrada, con el dinero a favor y en contra de cada partido, el de los grandes apostadores, el de las billeteras nuevas, las probabilidades y los giros. Listo para cruzar con la agenda de campaña, los debates y la publicación de encuestas (la ley española prohíbe publicar encuestas en los cinco días anteriores a la votación: vale la pena mirar qué hacen las apuestas en esos días).
- `report.json`, `funders.json`, `labels.json`: como en la edición brasileña. `labels.json` (etiquetas públicas de servicios, revisadas a mano en Polygonscan) viene de Cash Out Brasil.

Ninguna dirección de billetera o de origen aparece en los resultados, y cualquier número que describa menos de 3 billeteras queda oculto.

### Archivos

- `collect.js` busca los datos y escribe una instantánea.
- `lib.js` ordena las apuestas, detecta las fuera de lo común y guarda la configuración (mercado, partidos, umbrales, hora final).
- `engine.js` es el motor de marmolado (navegador y Node).
- `render-frame.js` genera las imágenes.
- `page.html` es la página; `node scripts/build.js` genera `index.html` a partir de ella.
- `scripts/backfill.js` trae las semanas anteriores; `scripts/sample.js` genera datos de prueba (no reales).

---

## English

Cash Out · España follows the money bet on Polymarket, a cryptocurrency betting site, on Spain's general election of 29 November 2026. Every hour until the polls close, it records every bet of the previous 24 hours on the "Spain General Election Winner" market (which party wins the most seats) and turns them into a marbled image, one drop of ink per bet. One image is kept per hour.

It is the second edition of [Cash Out](https://github.com/lll-uuu/cash-out), which followed the money bet on Brazil's presidential runoff.

**Who speculates on our futures?**

Spain blocked Polymarket in May 2026 for operating without a gambling licence, yet anyone with a crypto wallet can still bet on who will govern the country, from anywhere, without identifying themselves. The project asks how capital moves through contemporary entanglements of colonial power and technology: whose money moves the odds of a Spanish election, when it moves and where it comes from. And a new question carried over from the Brazilian edition: do the same wallets turn up, on the same side, in elections in different countries where the far right is growing?

### Reading the image

Red ink is bets on PSOE, blue on PP, green on Vox. Dimmed grey ink is bets *against* a party (buying its "no"), keeping a trace of that party's colour; with three parties a bet against one is not a bet for another. White and cream are $1,000+ bets by whales or new wallets, edged in the colour of what they backed. Each hour the bath is combed once, and each party pulls the comb in its own direction as hard as its odds: PSOE vertically, PP horizontally, Vox diagonally. Everything else (placement and shade from the wallet address, specks from transaction hashes, the pUSD ground) works as in the Brazilian edition.

Note on "against" bets: buying the "no" of a near-certain loser (Vox winning the most seats) costs almost a dollar and pays slightly more. It is mostly a way to earn a small yield, not a political position, so expect a lot of grey "against Vox". Bets *for* Vox are the ones that go against the odds.

### Setup

1. Create a new GitHub repository and push everything in this folder, including the hidden `.github` folder, to `main`.
2. In **Actions**, enable workflows, then run **Cash Out España hourly** once.
3. Run **Cash Out España backfill** once to pull the weeks since the market opened (5 October) as one snapshot per day. The API only pages back so far; the log says how far it reached.
4. **Settings → Pages → Deploy from a branch → main / (root)**.
5. Optional: a free Etherscan key as the repository secret `ETHERSCAN_API_KEY`, for the funding section of the analysis.

The last frame is 20:00 UTC on Sunday 29 November (21:00 in Madrid), when the Canary Islands, the last to vote, close their polls.

### Analysis

`analyze.js` runs daily and writes `analysis/informe.md` (in Spanish), `hourly.csv` and `report.json`. The analysis is the same as in the Brazilian edition, generalised to three parties with bets for and against, with times in Madrid time. It adds a **cross-check with Cash Out Brasil**: how many of the wallets betting on Spain also bet on Brazil's presidential election, and whether that money backed Flávio Bolsonaro or Lula, grouped by what they back in Spain. No wallet or funder address is ever published; any figure describing fewer than 3 wallets is suppressed.
