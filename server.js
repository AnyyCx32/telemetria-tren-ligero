// =======================================================
//  Backend Telemetría Trenes (MEJORADO CON MÚLTIPLES CANALES)
// =======================================================

require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TEST_MODE = process.env.TEST_MODE === "true";
const { generarMockTelemetry } = require("./test-data/mockTelemetry");

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// =================== CONFIG ===================

// Construir array de canales desde variables de entorno
const canales = [];
let i = 1;
while (process.env[`CANAL_${i}_ID`] && process.env[`CANAL_${i}_KEY`]) {
  canales.push({
    id: process.env[`CANAL_${i}_ID`],
    readKey: process.env[`CANAL_${i}_KEY`],
    nombre: process.env[`CANAL_${i}_NOMBRE`] || `Canal ${i}`
  });
  i++;
}
console.log(`📡 Configurados ${canales.length} canales`);
if (TEST_MODE) console.log("⚠️ MODO DE PRUEBA activo: usando datos simulados locales");

const FUENTES = {
  0: "Sin posición",
  1: "GNSS + ENU",
  2: "Navegación por estima"
};

const IMU_ESTADOS = {
  0: "Desconocido",
  1: "Correcta",
  2: "Deriva ICM-20948",
  3: "Desacuerdo",
  4: "Falla del sensor"
};

const RTK_ESTADOS = {
  0: "Sin corrección",
  1: "Flotante",
  2: "Fija"
};

const NORTH_ESTADOS = {
  0: "No válida",
  1: "Válida"
};

const MAX_EDAD_HORAS = 5;
const MAX_EDAD_MS = MAX_EDAD_HORAS * 60 * 60 * 1000;
const HISTORIAL_PRELOAD = 200;   // registros por nodo que se cargan al arrancar
const MAX_PRELOAD = 200;         // feeds pedidos a ThingSpeak en la precarga
const HISTORIAL_MAX_RUTA = 15;
const TABLA_MAX = 500;
const MAX = 20;

// =================== ESTADO ===================

let historialPorNodo = {};
let historialGlobal = [];
let estadoNodos = [];
let dedupTestPerformed = false;

// =================== UTILIDADES ===================

function toRad(x) { return x * Math.PI / 180; }

function distanciaMetros(p1, p2) {
  const R = 6371000;
  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) *
    Math.cos(toRad(p2.lat)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estadoGPS(seg) {
  if (seg < 35) return "verde";
  if (seg <= 60) return "amarillo";
  return "rojo";
}

function nodeKey(id_tren, id_nodo) {
  return `${id_tren}:${id_nodo}`;
}

function nodeLabel(id_nodo) {
  if (id_nodo === 0) return "A";
  if (id_nodo === 1) return "B";
  return String(id_nodo);
}

function parseStatus(status) {
  const result = {
    source: null,
    imuHealth: null,
    heading: null,
    northValid: null,
    rtk: null,
    refSd: false,
    icmFloorCal: null,
    icmAxisCal: null,
    mpuFloorCal: null,
    mpuAxisCal: null
  };

  if (!status || typeof status !== "string") return result;

  result.refSd = /_REFSD/.test(status);

  const mainRegex = /SRC_(\d+)_IMU_(\d+)_HDG_(\d+)_NORTH_(\d+)_RTK_(\d+)(?:_REFSD)?_CAL_I(\d)(\d)M(\d)(\d)/;
  const match = status.match(mainRegex);
  if (!match) return result;

  result.source = parseInt(match[1], 10);
  result.imuHealth = parseInt(match[2], 10);
  result.heading = parseInt(match[3], 10);
  result.northValid = parseInt(match[4], 10);
  result.rtk = parseInt(match[5], 10);
  result.icmFloorCal = parseInt(match[6], 10);
  result.icmAxisCal = parseInt(match[7], 10);
  result.mpuFloorCal = parseInt(match[8], 10);
  result.mpuAxisCal = parseInt(match[9], 10);

  return result;
}

function normalizarFeed(f) {
  const ahora = Date.now();
  const lat = parseFloat(f.field1);
  const lon = parseFloat(f.field2);
  const rapidez = f.field3 != null ? parseFloat(f.field3) : null;
  const rumbo = f.field4 != null ? parseFloat(f.field4) : null;
  const tSinGPS = f.field5 != null ? parseFloat(f.field5) : null;
  const id_tren = f.field6 != null ? parseInt(f.field6, 10) : null;
  const id_nodo = f.field7 != null ? parseInt(f.field7, 10) : null;
  const vibracion = f.field8 != null ? parseFloat(f.field8) : null;
  const timestamp = f.created_at || new Date().toISOString();
  const ts = Date.parse(timestamp);

  return {
    entryId: f.entry_id || null,
    lat,
    lon,
    rapidez: Number.isFinite(rapidez) ? rapidez : null,
    rumbo: Number.isFinite(rumbo) ? rumbo : null,
    tSinGPS: Number.isFinite(tSinGPS) ? tSinGPS : null,
    id_tren: Number.isInteger(id_tren) ? id_tren : null,
    id_nodo: Number.isInteger(id_nodo) ? id_nodo : null,
    vibracion: Number.isFinite(vibracion) ? vibracion : null,
    statusRaw: f.status || null,
    status: parseStatus(f.status || ""),
    timestamp,
    timestampMs: ts
  };
}

function agregarAHistorial(key, punto) {
  if (!historialPorNodo[key]) historialPorNodo[key] = [];
  const ruta = historialPorNodo[key];
  const ultimo = ruta[ruta.length - 1];

  const mismoRegistro = ultimo && (
    (punto.entryId && ultimo.entryId === punto.entryId) ||
    (!punto.entryId && ultimo.timestamp === punto.timestamp) ||
    (!punto.entryId && ultimo.lat === punto.lat && ultimo.lon === punto.lon && ultimo.rapidez === punto.rapidez && ultimo.rumbo === punto.rumbo && ultimo.tSinGPS === punto.tSinGPS)
  );

  if (mismoRegistro) return false;

  ruta.push(punto);
  if (ruta.length > HISTORIAL_MAX_RUTA) ruta.shift();

  historialGlobal.push({ id_tren: punto.id_tren, id_nodo: punto.id_nodo, ...punto });
  if (historialGlobal.length > TABLA_MAX) historialGlobal.shift();

  return true;
}

function validarDeduplicacion() {
  const keys = Object.keys(historialPorNodo);
  if (!keys.length) return;
  const key = keys[0];
  const ruta = historialPorNodo[key];
  const ultimo = ruta[ruta.length - 1];
  if (!ultimo) return;

  const duplicado = { ...ultimo };
  const noCrece = !agregarAHistorial(key, duplicado);

  const nuevo = { ...ultimo, entryId: (Number(ultimo.entryId) || 0) + 9999 };
  const siCrece = agregarAHistorial(key, nuevo);

  console.log(`🧪 Prueba de deduplicación en modo TEST: same entry_id -> ${noCrece ? "no crece" : "crece"}; mismo contenido nuevo entry_id -> ${siCrece ? "crece" : "no crece"}`);
}

// =================== THINGSPEAK ===================

async function leerCanal(canal, resultados = MAX) {
  try {
    const url = `https://api.thingspeak.com/channels/${canal.id}/feeds.json?api_key=${canal.readKey}&results=${resultados}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const js = await res.json();
    if (!js || !Array.isArray(js.feeds)) return [];

    const ahora = Date.now();
    return js.feeds
      .map(normalizarFeed)
      .filter(f => {
        if (f.lat === null || f.lon === null || f.id_tren === null || f.id_nodo === null || f.tSinGPS === null) return false;
        if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon) || !Number.isFinite(f.tSinGPS)) return false;
        if (f.rumbo === null || !Number.isFinite(f.rumbo)) return false;
        if (isNaN(f.timestampMs)) return false;
        return (ahora - f.timestampMs) <= MAX_EDAD_MS;
      });
  } catch (error) {
    console.error(`❌ Error leyendo canal ${canal.id}:`, error.message);
    return [];
  }
}

// =================== ORIGEN DE DATOS ===================

// leerCanal() ya devuelve feeds normalizados; solo el mock entrega feeds crudos
// de ThingSpeak, asi que normalizarFeed se aplica unicamente en modo prueba.
async function obtenerDatos(resultados = MAX) {
  if (TEST_MODE) {
    return generarMockTelemetry()
      .map(normalizarFeed)
      .filter(f => f.id_tren !== null && f.id_nodo !== null);
  }
  const lecturas = await Promise.all(canales.map(c => leerCanal(c, resultados)));
  return lecturas.flat().filter(f => f.id_tren !== null && f.id_nodo !== null);
}

// =================== PRECARGA ===================

async function precargarHistorial() {
  console.log("⏳ Precargando historial...");
  const datos = await obtenerDatos(MAX_PRELOAD);

  const porNodo = {};
  datos.forEach(d => {
    const key = nodeKey(d.id_tren, d.id_nodo);
    if (!porNodo[key]) porNodo[key] = [];
    porNodo[key].push(d);
  });

  for (const key in porNodo) {
    porNodo[key]
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(-HISTORIAL_PRELOAD)
      .forEach(p => agregarAHistorial(key, p));
  }
  const rutas = Object.keys(historialPorNodo)
    .map(k => `${k} -> ${historialPorNodo[k].length}/${HISTORIAL_MAX_RUTA} pts`)
    .join(", ");
  console.log(`✅ Precarga lista: ${historialGlobal.length} registros en la tabla`);
  console.log(`🛰️ Rutas restauradas desde ThingSpeak (tren:nodo): ${rutas || "ninguna"}`);
}

// =================== PROCESAMIENTO ===================

function procesar(datos) {
  const nodos = {};
  const salida = [];

  datos.forEach(d => {
    const key = nodeKey(d.id_tren, d.id_nodo);
    if (!nodos[key]) {
      nodos[key] = { id_tren: d.id_tren, id_nodo: d.id_nodo, puntos: [] };
    }
    nodos[key].puntos.push(d);
  });

  for (const key in nodos) {
    const nodo = nodos[key];
    const puntosOrdenados = nodo.puntos.sort((a, b) => b.timestampMs - a.timestampMs);
    const activo = puntosOrdenados[0];
    if (!activo) continue;

    agregarAHistorial(key, activo);

    salida.push({
      id_tren: activo.id_tren,
      id_nodo: activo.id_nodo,
      nodo_txt: nodeLabel(activo.id_nodo),
      latitud: activo.lat,
      longitud: activo.lon,
      lat: activo.lat,
      lon: activo.lon,
      rapidez: activo.rapidez,
      velocidad: activo.rapidez,
      rumbo: activo.rumbo,
      tSinGPS: activo.tSinGPS,
      gps_off_s: activo.tSinGPS,
      vibracion: activo.vibracion,
      source: activo.status.source,
      source_txt: FUENTES[activo.status.source] || null,
      imuHealth: activo.status.imuHealth,
      imuHealth_txt: IMU_ESTADOS[activo.status.imuHealth] || null,
      rtk: activo.status.rtk,
      rtk_txt: RTK_ESTADOS[activo.status.rtk] || null,
      northValid: activo.status.northValid,
      northValid_txt: NORTH_ESTADOS[activo.status.northValid] || null,
      refSd: activo.status.refSd,
      calibraciones: {
        icmFloorCal: activo.status.icmFloorCal,
        icmAxisCal: activo.status.icmAxisCal,
        mpuFloorCal: activo.status.mpuFloorCal,
        mpuAxisCal: activo.status.mpuAxisCal
      },
      statusRaw: activo.statusRaw,
      timestamp: activo.timestamp,
      posicion: {
        lat: activo.lat,
        lon: activo.lon,
        tSinGPS: activo.tSinGPS,
        rumbo: activo.rumbo,
        timestamp: activo.timestamp
      },
      estado_gps: estadoGPS(activo.tSinGPS),
      historial: historialPorNodo[key] || []
    });
  }

  return salida;
}

// =================== CICLO ===================

async function actualizar() {
  const datos = await obtenerDatos();

  estadoNodos = procesar(datos);

  if (TEST_MODE && !dedupTestPerformed) {
    validarDeduplicacion();
    dedupTestPerformed = true;
  }

  console.log(`✔ Backend actualizado: ${estadoNodos.length} nodos activos${TEST_MODE ? " (modo prueba)" : ""}`);
}

async function iniciarCiclo() {
  await actualizar();
  setTimeout(iniciarCiclo, 15000);
}

// =================== API ===================

app.get("/api/estado", (req, res) => res.json(estadoNodos));

app.get("/api/historial", (req, res) => {
  let { limit = 15, tren } = req.query;
  limit = Math.min(parseInt(limit, 10) || 15, 100);
  let historial = historialGlobal;
  if (tren && tren !== 'todos') {
    const idTren = parseInt(tren, 10);
    if (!isNaN(idTren)) historial = historial.filter(h => h.id_tren === idTren);
  }
  const respuesta = [...historial].reverse().slice(0, limit).map(h => ({
    id_tren: h.id_tren,
    id_nodo: h.id_nodo,
    nodo_txt: nodeLabel(h.id_nodo),
    latitud: h.lat,
    longitud: h.lon,
    lat: h.lat,
    lon: h.lon,
    rapidez: h.rapidez,
    velocidad: h.rapidez,
    rumbo: h.rumbo,
    tSinGPS: h.tSinGPS,
    gps_off_s: h.tSinGPS,
    vibracion: h.vibracion,
    source: h.status?.source ?? null,
    source_txt: h.status?.source != null ? FUENTES[h.status.source] : null,
    imuHealth: h.status?.imuHealth ?? null,
    imuHealth_txt: h.status?.imuHealth != null ? IMU_ESTADOS[h.status.imuHealth] : null,
    timestamp: h.timestamp
  }));
  res.json(respuesta);
});

// Compatibilidad
app.get("/api/tabla", (req, res) => {
  const respuesta = [...historialGlobal].reverse().map(h => ({
    id_tren: h.id_tren,
    id_nodo: h.id_nodo,
    nodo_txt: nodeLabel(h.id_nodo),
    latitud: h.lat,
    longitud: h.lon,
    lat: h.lat,
    lon: h.lon,
    rapidez: h.rapidez,
    velocidad: h.rapidez,
    rumbo: h.rumbo,
    tSinGPS: h.tSinGPS,
    gps_off_s: h.tSinGPS,
    vibracion: h.vibracion,
    source: h.status?.source ?? null,
    source_txt: h.status?.source != null ? FUENTES[h.status.source] : null,
    imuHealth: h.status?.imuHealth ?? null,
    imuHealth_txt: h.status?.imuHealth != null ? IMU_ESTADOS[h.status.imuHealth] : null,
    timestamp: h.timestamp
  }));
  res.json(respuesta);
});

app.get("/api/config", (req, res) => {
  res.json({ testMode: TEST_MODE });
});

// =================== ARRANQUE ===================

app.listen(PORT, async () => {
  console.log(`🚀 Backend activo en http://localhost:${PORT}`);
  await precargarHistorial();
  iniciarCiclo();
});