const BASE_TIME = Date.now();

const rutas = {
  "1:0": {
    tren: 1,
    nodo: 0,
    baseLat: 19.3250,
    baseLon: -99.1900,
    stepLat: 0.00012,
    stepLon: 0.00028,
    direccion: 95,
    velocidad: 24,
    path: []
  },
  "1:1": {
    tren: 1,
    nodo: 1,
    baseLat: 19.3270,
    baseLon: -99.1880,
    stepLat: 0.00010,
    stepLon: 0.00022,
    direccion: 100,
    velocidad: 22,
    path: []
  },
  "2:0": {
    tren: 2,
    nodo: 0,
    baseLat: 19.3360,
    baseLon: -99.1905,
    stepLat: -0.00008,
    stepLon: 0.00025,
    direccion: 80,
    velocidad: 18,
    path: []
  },
  "2:1": {
    tren: 2,
    nodo: 1,
    baseLat: 19.3342,
    baseLon: -99.1887,
    stepLat: -0.00006,
    stepLon: 0.00021,
    direccion: 85,
    velocidad: 20,
    path: []
  }
};

const estadoStatus = [
  { imu: 0, north: 1, rtk: 0, cal: 'I00M00', refSd: false },
  { imu: 1, north: 1, rtk: 1, cal: 'I10M10', refSd: false },
  { imu: 2, north: 0, rtk: 2, cal: 'I11M11', refSd: true },
  { imu: 3, north: 1, rtk: 0, cal: 'I10M10', refSd: false },
  { imu: 4, north: 0, rtk: 1, cal: 'I11M11', refSd: false }
];

const vibraciones = [0.010, 0.018, 0.025, 0.035, 0.020, 0.014, 0.022];

const gnssSequence = [
  { source: 1, tSinGPS: 0 },
  { source: 1, tSinGPS: 5 },
  { source: 2, tSinGPS: 20 },
  { source: 2, tSinGPS: 40 },
  { source: 2, tSinGPS: 55 },
  { source: 2, tSinGPS: 70 },
  { source: 1, tSinGPS: 0 }
];

function aleatorio(min, max) {
  return Math.random() * (max - min) + min;
}

function pad3(value) {
  return String(Math.round(value)).padStart(3, '0');
}

function crearStatus(config, rumbo) {
  const rounded = Number(rumbo.toFixed(1));
  const hdg = pad3(rounded);
  return `SRC_${config.source}_IMU_${config.imu}_HDG_${hdg}_NORTH_${config.north}_RTK_${config.rtk}${config.refSd ? '_REFSD' : ''}_CAL_${config.cal}`;
}

function generarPunto(base) {
  const index = base.path.length;
  const avance = index + 1;
  const lat = base.baseLat + base.stepLat * avance + aleatorio(-0.00002, 0.00002);
  const lon = base.baseLon + base.stepLon * avance + aleatorio(-0.00002, 0.00002);
  const velocidad = Math.max(0, Math.min(45, base.velocidad + aleatorio(-3, 3)));
  const rumbo = (base.direccion + aleatorio(-7, 7) + 360) % 360;
  const vibracion = vibraciones[index % vibraciones.length];
  const gnss = gnssSequence[index % gnssSequence.length];
  const statusIndex = index % estadoStatus.length;
  const status = crearStatus({ ...estadoStatus[statusIndex], source: gnss.source }, rumbo);
  const entryId = BASE_TIME + index + base.tren * 100 + base.nodo * 10;

  return {
    entry_id: entryId,
    field1: lat.toFixed(6),
    field2: lon.toFixed(6),
    field3: velocidad.toFixed(2),
    field4: rumbo.toFixed(1),
    field5: gnss.tSinGPS,
    field6: base.tren,
    field7: base.nodo,
    field8: vibracion.toFixed(3),
    status,
    created_at: new Date(BASE_TIME + index * 15000).toISOString()
  };
}

function generarMockTelemetry() {
  const resultados = [];
  Object.values(rutas).forEach(base => {
    const punto = generarPunto(base);
    base.path.push(punto);
    if (base.path.length > 20) base.path.shift();
    resultados.push(punto);
  });
  return resultados;
}

module.exports = { generarMockTelemetry };