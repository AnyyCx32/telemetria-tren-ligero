// =======================================================
//  Backend Telemetría Trenes (MEJORADO CON MÚLTIPLES CANALES)
// =======================================================

require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

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

const DIRECCIONES = {
  0: "Taxqueña",
  1: "Xochimilco"
};

const MAX_EDAD_HORAS = 5;
const MAX_EDAD_MS = MAX_EDAD_HORAS * 60 * 60 * 1000;
const HISTORIAL_PRELOAD = 5;
const HISTORIAL_MAX_RUTA = 15;
const TABLA_MAX = 500;
const MAX = 20;

// =================== ESTADO ===================

let historialTrenes = {};
let historialGlobal = [];
let estadoTrenes = [];

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

function agregarAHistorial(id_tren, punto) {
  if (!historialTrenes[id_tren]) historialTrenes[id_tren] = [];
  historialTrenes[id_tren].push(punto);
  if (historialTrenes[id_tren].length > HISTORIAL_MAX_RUTA)
    historialTrenes[id_tren].shift();

  historialGlobal.push({ id_tren, ...punto });
  if (historialGlobal.length > TABLA_MAX)
    historialGlobal.shift();
}

// =================== THINGSPEAK ===================

async function leerCanal(canal) {
  try {
    const url = `https://api.thingspeak.com/channels/${canal.id}/feeds.json?api_key=${canal.readKey}&results=${MAX}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const js = await res.json();
    if (!js || !Array.isArray(js.feeds)) return [];

    const ahora = Date.now();
    return js.feeds
      .filter(f => {
        if (!f.field1 || !f.field2 || !f.field6) return false;
        const lat = parseFloat(f.field1);
        const lon = parseFloat(f.field2);
        const gps_off = parseFloat(f.field5);
        if (isNaN(lat) || isNaN(lon) || isNaN(gps_off)) return false;
        const t = Date.parse(f.created_at);
        return !isNaN(t) && (ahora - t) <= MAX_EDAD_MS;
      })
      .map(f => ({
        lat: parseFloat(f.field1),
        lon: parseFloat(f.field2),
        velocidad: f.field3 ? parseFloat(f.field3) : null,
        direccion: parseInt(f.field4, 10),
        gps_off_s: parseFloat(f.field5),
        id_tren: parseInt(f.field6, 10),
        timestamp: f.created_at
      }));
  } catch (error) {
    console.error(`❌ Error leyendo canal ${canal.id}:`, error.message);
    return [];
  }
}

// =================== PRECARGA ===================

async function precargarHistorial() {
  console.log("⏳ Precargando historial...");
  const promesas = canales.map(c => leerCanal(c));
  const resultados = await Promise.all(promesas);
  const datos = resultados.flat();

  const porTren = {};
  datos.forEach(d => {
    if (!porTren[d.id_tren]) porTren[d.id_tren] = [];
    porTren[d.id_tren].push(d);
  });

  for (const id in porTren) {
    porTren[id]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(-HISTORIAL_PRELOAD)
      .forEach(p => {
        agregarAHistorial(p.id_tren, {
          lat: p.lat,
          lon: p.lon,
          gps_off_s: p.gps_off_s,
          timestamp: p.timestamp
        });
      });
  }
  console.log("✅ Precarga lista");
}

// =================== PROCESAMIENTO ===================

function procesar(datos) {
  const trenes = {};
  const salida = [];

  datos.forEach(d => {
    if (!trenes[d.id_tren]) {
      trenes[d.id_tren] = { id_tren: d.id_tren, direccion: d.direccion, puntos: [] };
    }
    trenes[d.id_tren].puntos.push(d);
  });

  for (const id in trenes) {
    const t = trenes[id];
    const puntosOrdenados = t.puntos.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const activo = puntosOrdenados[0];
    if (!activo) continue;

    agregarAHistorial(id, {
      lat: activo.lat,
      lon: activo.lon,
      gps_off_s: activo.gps_off_s,
      timestamp: activo.timestamp
    });

    salida.push({
      id_tren: id,
      velocidad: activo.velocidad,
      direccion_txt: DIRECCIONES[activo.direccion] || "Desconocida",
      posicion: { lat: activo.lat, lon: activo.lon, gps_off_s: activo.gps_off_s },
      estado_gps: estadoGPS(activo.gps_off_s),
      historial: historialTrenes[id] || []
    });
  }
  return salida;
}

// =================== CICLO ===================

async function actualizar() {
  const promesas = canales.map(c => leerCanal(c));
  const resultados = await Promise.all(promesas);
  const datos = resultados.flat();
  estadoTrenes = procesar(datos);
  console.log(`✔ Backend actualizado: ${estadoTrenes.length} trenes activos`);
}

async function iniciarCiclo() {
  await actualizar();
  setTimeout(iniciarCiclo, 15000);
}

// =================== API ===================

app.get("/api/estado", (req, res) => res.json(estadoTrenes));

app.get("/api/historial", (req, res) => {
  let { limit = 15, tren } = req.query;
  limit = Math.min(parseInt(limit) || 15, 100);
  let historial = historialGlobal;
  if (tren && tren !== 'todos') {
    const idTren = parseInt(tren);
    if (!isNaN(idTren)) historial = historial.filter(h => h.id_tren === idTren);
  }
  res.json([...historial].reverse().slice(0, limit));
});

// Compatibilidad
app.get("/api/tabla", (req, res) => res.json([...historialGlobal].reverse()));

// =================== ARRANQUE ===================

app.listen(PORT, async () => {
  console.log(`🚀 Backend activo en http://localhost:${PORT}`);
  await precargarHistorial();
  iniciarCiclo();
});