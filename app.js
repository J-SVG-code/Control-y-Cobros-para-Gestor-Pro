import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// =========================================================================
// 1. PEGA AQUÍ LA CONFIGURACIÓN DE TU PROYECTO DE FIREBASE
// =========================================================================
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROJECT_ID.firebaseapp.com",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_PROJECT_ID.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Colecciones en Firestore
const STORES_COL = "stores";
const PAYMENTS_COL = "payment_references";

// Estado en memoria
let storesCache = [];
let refsCache = [];

// Elementos del DOM
const dbStatus = document.getElementById("dbStatus");
const storesTableBody = document.getElementById("storesTableBody");
const refsTableBody = document.getElementById("refsTableBody");
const searchInput = document.getElementById("searchInput");

// Inicializar fechas por defecto en los inputs
const todayISO = toISODate(new Date());
document.getElementById("regDate").value = todayISO;
document.getElementById("payDate").value = todayISO;

// =========================================================================
// UTILIDADES DE FECHA (Cobro mensual el mismo día de ingreso)
// =========================================================================
function toISODate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseISODate(isoStr) {
  const [y, m, d] = isoStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function daysInMonth(year, monthIndexZeroBased) {
  return new Date(year, monthIndexZeroBased + 1, 0).getDate();
}

/**
 * Calcula el mismo día `billingDay` en el mes siguiente a partir de `baseDate`.
 * Si `baseDate` es el día en curso o anterior en su mes, avanza al mes siguiente
 * manteniendo `billingDay` (o el último día del mes si el mes es más corto, ej. 30/31 en Feb).
 */
function getNextBillingDate(baseDate, billingDay) {
  let targetYear = baseDate.getFullYear();
  let targetMonth = baseDate.getMonth() + 1;
  if (targetMonth > 11) {
    targetYear += Math.floor(targetMonth / 12);
    targetMonth = targetMonth % 12;
  }
  const maxDay = daysInMonth(targetYear, targetMonth);
  const safeDay = Math.min(billingDay, maxDay);
  return new Date(targetYear, targetMonth, safeDay, 0, 0, 0, 0);
}

// =========================================================================
// 2. REGISTRAR NUEVO NEGOCIO (1er MES GRATIS)
// =========================================================================
document.getElementById("registerStoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("registerFeedback");
  feedback.className = "feedback";

  const storeId = document.getElementById("regStoreId").value.trim();
  const ownerEmail = document.getElementById("regEmail").value.trim().toLowerCase();
  const bizName = document.getElementById("regBizName").value.trim() || storeId;
  const ingresoDate = parseISODate(document.getElementById("regDate").value);

  const billingDay = ingresoDate.getDate();
  const nextDueDate = getNextBillingDate(ingresoDate, billingDay);
  const nextDueISO = toISODate(nextDueDate);

  try {
    const storeRef = doc(db, STORES_COL, storeId);
    const existing = await getDoc(storeRef);

    if (existing.exists()) {
      feedback.textContent = `El ID "${storeId}" ya existe en Firebase.`;
      feedback.classList.add("err");
      return;
    }

    await setDoc(storeRef, {
      storeId,
      ownerEmail,
      bizName,
      fechaIngreso: toISODate(ingresoDate),
      diaCobro: billingDay,
      primerMesGratis: true,
      trialEndsAt: nextDueISO,
      proximoVencimiento: nextDueISO,
      paidUntil: nextDueISO,
      status: "trial",
      suspended: false,
      inhabilitada: false,
      activa: true,
      suspensionReason: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    feedback.textContent = `Negocio "${storeId}" registrado con 1er mes gratis. Próximo cobro: ${nextDueISO} (día ${billingDay} de cada mes).`;
    feedback.classList.add("ok");
    e.target.reset();
    document.getElementById("regDate").value = todayISO;
  } catch (err) {
    console.error(err);
    feedback.textContent = `Error al registrar: ${err.message}`;
    feedback.classList.add("err");
  }
});

// =========================================================================
// 3. APLICAR PAGO POR ID + REFERENCIA (SIN DUPLICADOS)
// =========================================================================
document.getElementById("applyPaymentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("paymentFeedback");
  feedback.className = "feedback";

  const storeId = document.getElementById("payStoreId").value.trim();
  const reference = document.getElementById("payRef").value.trim().toUpperCase();
  const amount = document.getElementById("payAmount").value.trim() || "No especificado";
  const payDateStr = document.getElementById("payDate").value;

  try {
    // 1. Verificar si la referencia ya fue usada
    const refDocRef = doc(db, PAYMENTS_COL, reference);
    const refSnap = await getDoc(refDocRef);
    if (refSnap.exists()) {
      const usedBy = refSnap.data().storeId;
      feedback.textContent = `Referencia "${reference}" DUPLICADA. Ya fue usada en el negocio "${usedBy}".`;
      feedback.classList.add("err");
      return;
    }

    // 2. Verificar que el negocio exista
    const storeRef = doc(db, STORES_COL, storeId);
    const storeSnap = await getDoc(storeRef);
    if (!storeSnap.exists()) {
      feedback.textContent = `No existe ningún negocio con el ID "${storeId}".`;
      feedback.classList.add("err");
      return;
    }

    const storeData = storeSnap.data();
    const billingDay = storeData.diaCobro || parseISODate(storeData.fechaIngreso || todayISO).getDate();
    const currentDue = storeData.proximoVencimiento ? parseISODate(storeData.proximoVencimiento) : parseISODate(payDateStr);
    const paymentDateObj = parseISODate(payDateStr);

    // Base para calcular el siguiente mes: si aún no vence o si ya venció, avanzamos 1 ciclo desde la fecha de cobro/pago
    const baseForNext = currentDue > paymentDateObj ? currentDue : paymentDateObj;
    const nextDueDate = getNextBillingDate(baseForNext, billingDay);
    const nextDueISO = toISODate(nextDueDate);

    // 3. Guardar referencia usada para impedir duplicados
    await setDoc(refDocRef, {
      reference,
      storeId,
      ownerEmail: storeData.ownerEmail || "",
      amount,
      fechaPago: payDateStr,
      nuevoVencimiento: nextDueISO,
      createdAt: serverTimestamp()
    });

    // 4. Activar negocio y actualizar vencimiento en Firestore
    await updateDoc(storeRef, {
      status: "active",
      suspended: false,
      inhabilitada: false,
      activa: true,
      suspensionReason: "",
      lastPaymentRef: reference,
      lastPaymentDate: payDateStr,
      paidUntil: nextDueISO,
      proximoVencimiento: nextDueISO,
      updatedAt: serverTimestamp()
    });

    feedback.textContent = `Pago validado (Ref: ${reference}). "${storeId}" ACTIVO hasta ${nextDueISO}.`;
    feedback.classList.add("ok");
    e.target.reset();
    document.getElementById("payDate").value = todayISO;
  } catch (err) {
    console.error(err);
    feedback.textContent = `Error al aplicar pago: ${err.message}`;
    feedback.classList.add("err");
  }
});

// =========================================================================
// 4. BLOQUEO AUTOMÁTICO EN FIREBASE CUANDO LLEGA SU DÍA SIN PAGO
// =========================================================================
async function runAutomaticExpirationCheck() {
  const todayStr = toISODate(new Date());
  const todayObj = parseISODate(todayStr);
  let blockedCount = 0;

  for (const store of storesCache) {
    if (!store.proximoVencimiento) continue;
    const dueObj = parseISODate(store.proximoVencimiento);

    // Si hoy es igual o posterior al día de cobro/vencimiento y no está suspendido aún, lo bloquea
    const isDueTodayOrPast = todayObj >= dueObj;
    const alreadyBlocked = store.inhabilitada === true || store.suspended === true || store.status === "suspended";

    if (isDueTodayOrPast && !alreadyBlocked) {
      const storeRef = doc(db, STORES_COL, store.storeId);
      await updateDoc(storeRef, {
        status: "suspended",
        suspended: true,
        inhabilitada: true,
        activa: false,
        suspensionReason: `Vencimiento alcanzado (${store.proximoVencimiento}) sin pago registrado.`,
        updatedAt: serverTimestamp()
      });
      blockedCount++;
    }
  }
  return blockedCount;
}

document.getElementById("btnRunAutoCheck").addEventListener("click", async () => {
  const count = await runAutomaticExpirationCheck();
  alert(count > 0
    ? `Revisión completada: se bloquearon ${count} negocio(s) vencido(s) en Firebase.`
    : "Revisión completada: no hay negocios vencidos pendientes por bloquear.");
});

// Acciones manuales rápidas por fila (bloquear o reactivar manualmente si lo necesitas)
window.toggleStoreBlock = async function (storeId, shouldBlock) {
  const storeRef = doc(db, STORES_COL, storeId);
  if (shouldBlock) {
    await updateDoc(storeRef, {
      status: "suspended",
      suspended: true,
      inhabilitada: true,
      activa: false,
      suspensionReason: "Bloqueado manualmente desde el panel.",
      updatedAt: serverTimestamp()
    });
  } else {
    const store = storesCache.find((s) => s.storeId === storeId);
    const billingDay = store?.diaCobro || new Date().getDate();
    const nextDueISO = toISODate(getNextBillingDate(new Date(), billingDay));
    await updateDoc(storeRef, {
      status: "active",
      suspended: false,
      inhabilitada: false,
      activa: true,
      suspensionReason: "",
      proximoVencimiento: nextDueISO,
      paidUntil: nextDueISO,
      updatedAt: serverTimestamp()
    });
  }
};

// =========================================================================
// 5. ESCUCHA EN TIEMPO REAL DESDE FIRESTORE + RENDERIZADO
// =========================================================================
let initialCheckDone = false;

onSnapshot(collection(db, STORES_COL), async (snap) => {
  dbStatus.textContent = "Conectado a Firebase";
  dbStatus.className = "badge badge-ok";

  storesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Ejecuta revisión automática al cargar los negocios por primera vez
  if (!initialCheckDone) {
    initialCheckDone = true;
    await runAutomaticExpirationCheck();
  }

  renderStatsAndTables();
}, (err) => {
  console.error(err);
  dbStatus.textContent = "Error de conexión";
  dbStatus.className = "badge badge-bad";
});

onSnapshot(collection(db, PAYMENTS_COL), (snap) => {
  refsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  document.getElementById("statRefs").textContent = refsCache.length;
  renderRefsTable();
});

searchInput.addEventListener("input", renderStatsAndTables);

function renderStatsAndTables() {
  const query = searchInput.value.trim().toLowerCase();
  const total = storesCache.length;
  const blocked = storesCache.filter((s) => s.inhabilitada || s.suspended || s.status === "suspended").length;
  const active = total - blocked;

  document.getElementById("statTotal").textContent = total;
  document.getElementById("statActive").textContent = active;
  document.getElementById("statBlocked").textContent = blocked;

  const filtered = storesCache.filter((s) =>
    (s.storeId || "").toLowerCase().includes(query) ||
    (s.ownerEmail || "").toLowerCase().includes(query) ||
    (s.bizName || "").toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    storesTableBody.innerHTML = `<tr><td colspan="7" class="empty-row">No hay negocios que coincidan.</td></tr>`;
    return;
  }

  storesTableBody.innerHTML = filtered.map((s) => {
    const isBlocked = s.inhabilitada || s.suspended || s.status === "suspended";
    const isTrial = !isBlocked && s.status === "trial";
    const badgeClass = isBlocked ? "badge-bad" : (isTrial ? "badge-trial" : "badge-ok");
    const statusLabel = isBlocked ? "Bloqueado" : (isTrial ? "Mes gratis (Activo)" : "Activo");

    return `
      <tr>
        <td><strong>${escapeHtml(s.storeId || s.id)}</strong></td>
        <td>${escapeHtml(s.ownerEmail || "-")}</td>
        <td>${escapeHtml(s.bizName || "-")}</td>
        <td>${escapeHtml(s.fechaIngreso || "-")} (Día ${s.diaCobro || "-"})</td>
        <td><strong>${escapeHtml(s.proximoVencimiento || "-")}</strong></td>
        <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
        <td class="actions-cell">
          ${isBlocked
            ? `<button class="btn btn-success btn-sm" onclick="toggleStoreBlock('${escapeJs(s.storeId || s.id)}', false)">Reactivar</button>`
            : `<button class="btn btn-danger btn-sm" onclick="toggleStoreBlock('${escapeJs(s.storeId || s.id)}', true)">Bloquear</button>`
          }
        </td>
      </tr>
    `;
  }).join("");
}

function renderRefsTable() {
  if (refsCache.length === 0) {
    refsTableBody.innerHTML = `<tr><td colspan="5" class="empty-row">Sin referencias registradas aún.</td></tr>`;
    return;
  }

  refsTableBody.innerHTML = refsCache.map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.reference || r.id)}</strong></td>
      <td>${escapeHtml(r.storeId || "-")}</td>
      <td>${escapeHtml(r.amount || "-")}</td>
      <td>${escapeHtml(r.fechaPago || "-")}</td>
      <td>${escapeHtml(r.nuevoVencimiento ? `Vence ${r.nuevoVencimiento}` : "Registrada")}</td>
    </tr>
  `).join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function escapeJs(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
