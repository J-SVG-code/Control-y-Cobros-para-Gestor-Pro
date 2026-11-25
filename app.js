import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
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
// 1. CONFIGURACIÓN DE TU PROYECTO DE FIREBASE
// =========================================================================
const firebaseConfig = {
  apiKey: "AIzaSyAtFPX1nB7dLgbQWAHBnqv3N2-hL5eWHgo",
  authDomain: "gestor-pro-venezuela.firebaseapp.com",
  projectId: "gestor-pro-venezuela",
  storageBucket: "gestor-pro-venezuela.firebasestorage.app",
  messagingSenderId: "767203590243",
  appId: "1:767203590243:web:dffac7819a1101ae733856"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Correos / cuentas exentas de bloqueo automático por vencimiento
const EXEMPT_EMAILS = ["joelvysalazar@gmail.com"];

function isExemptStore(store) {
  const email = (store?.ownerEmail || "").trim().toLowerCase();
  return EXEMPT_EMAILS.includes(email) || store?.exentoCobro === true || store?.nuncaSuspender === true;
}

function isStoreBlocked(store) {
  if (isExemptStore(store)) return false;
  return store?.inhabilitada === true || store?.suspended === true || store?.status === "suspended";
}

// Colecciones en Firestore
const STORES_COL = "stores";
const PAYMENTS_COL = "payment_references";

// Estado en memoria
let storesCache = [];
let refsCache = [];
let unsubStores = null;
let unsubRefs = null;
let initialCheckDone = false;

// Elementos del DOM
const dbStatus = document.getElementById("dbStatus");
const loginSection = document.getElementById("loginSection");
const panelSection = document.getElementById("panelSection");
const btnLogout = document.getElementById("btnLogout");
const btnRunAutoCheck = document.getElementById("btnRunAutoCheck");
const storesTableBody = document.getElementById("storesTableBody");
const refsTableBody = document.getElementById("refsTableBody");
const searchInput = document.getElementById("searchInput");

// Inicializar fechas por defecto en los inputs
const todayISO = toISODate(new Date());
document.getElementById("regDate").value = todayISO;
document.getElementById("payDate").value = todayISO;

// =========================================================================
// AUTENTICACIÓN DE ADMINISTRADOR
// =========================================================================
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("loginFeedback");
  feedback.className = "feedback";

  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    feedback.textContent = "";
  } catch (err) {
    console.error(err);
    feedback.textContent = `No se pudo iniciar sesión: ${err.message}`;
    feedback.classList.add("err");
  }
});

btnLogout.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, (user) => {
  if (unsubStores) { unsubStores(); unsubStores = null; }
  if (unsubRefs) { unsubRefs(); unsubRefs = null; }
  initialCheckDone = false;

  if (user) {
    loginSection.style.display = "none";
    panelSection.style.display = "flex";
    btnLogout.style.display = "inline-block";
    btnRunAutoCheck.style.display = "inline-block";
    startRealtimeListeners();
  } else {
    loginSection.style.display = "block";
    panelSection.style.display = "none";
    btnLogout.style.display = "none";
    btnRunAutoCheck.style.display = "none";
    dbStatus.textContent = "Inicia sesión";
    dbStatus.className = "badge badge-warn";
  }
});

// =========================================================================
// UTILIDADES DE FECHA (Soporta ISO "YYYY-MM-DD" y timestamps en ms)
// =========================================================================
function toISODate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseISODate(isoStr) {
  if (!isoStr || typeof isoStr !== "string" || !isoStr.includes("-")) return null;
  const [y, m, d] = isoStr.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function msToDate(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const dt = new Date(ms);
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0);
}

function daysInMonth(year, monthIndexZeroBased) {
  return new Date(year, monthIndexZeroBased + 1, 0).getDate();
}

function addMonthsKeepingBillingDay(baseDate, billingDay, monthsToAdd = 1) {
  let targetYear = baseDate.getFullYear();
  let targetMonth = baseDate.getMonth() + monthsToAdd;
  if (targetMonth > 11) {
    targetYear += Math.floor(targetMonth / 12);
    targetMonth = targetMonth % 12;
  }
  const maxDay = daysInMonth(targetYear, targetMonth);
  const safeDay = Math.min(billingDay, maxDay);
  return new Date(targetYear, targetMonth, safeDay, 0, 0, 0, 0);
}

function getStoreIngresoDate(store) {
  return parseISODate(store?.fechaIngreso) || msToDate(store?.createdAt);
}

function getStoreBillingDay(store) {
  if (typeof store?.diaCobro === "number" && store.diaCobro >= 1 && store.diaCobro <= 31) {
    return store.diaCobro;
  }
  const ing = getStoreIngresoDate(store);
  return ing ? ing.getDate() : null;
}

function getStoreDueDate(store) {
  if (store?.proximoVencimiento === "Nunca") return null;
  const fromISO = parseISODate(store?.proximoVencimiento);
  if (fromISO) return fromISO;

  const paidDate = msToDate(store?.paidUntil);
  const trialDate = msToDate(store?.trialEndsAt);
  if (paidDate && trialDate) return paidDate > trialDate ? paidDate : trialDate;
  return paidDate || trialDate || null;
}

function getStoreName(store) {
  return store?.nombre || store?.bizName || store?.storeId || store?.id || "-";
}

// =========================================================================
// REGISTRAR NUEVO NEGOCIO (1er MES GRATIS)
// =========================================================================
document.getElementById("registerStoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("registerFeedback");
  feedback.className = "feedback";

  const storeId = document.getElementById("regStoreId").value.trim();
  const ownerEmail = document.getElementById("regEmail").value.trim().toLowerCase();
  const bizName = document.getElementById("regBizName").value.trim() || storeId;
  const ingresoDate = parseISODate(document.getElementById("regDate").value) || new Date();

  const billingDay = ingresoDate.getDate();
  const nextDueDate = addMonthsKeepingBillingDay(ingresoDate, billingDay, 1);
  const nextDueISO = toISODate(nextDueDate);
  const exempt = EXEMPT_EMAILS.includes(ownerEmail);

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
      nombre: bizName,
      bizName,
      fechaIngreso: toISODate(ingresoDate),
      diaCobro: billingDay,
      primerMesGratis: !exempt,
      exentoCobro: exempt,
      nuncaSuspender: exempt,
      trialEndsAt: nextDueDate.getTime(),
      proximoVencimiento: exempt ? "Nunca" : nextDueISO,
      paidUntil: nextDueDate.getTime(),
      status: exempt ? "active" : "trial",
      suspended: false,
      inhabilitada: false,
      activa: true,
      suspensionReason: "",
      createdAt: ingresoDate.getTime(),
      updatedAt: serverTimestamp()
    });

    feedback.textContent = exempt
      ? `Negocio "${storeId}" registrado como EXENTO de bloqueo automático.`
      : `Negocio "${storeId}" registrado con 1er mes gratis. Próximo cobro: ${nextDueISO} (día ${billingDay} de cada mes).`;
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
// APLICAR PAGO POR ID + REFERENCIA (PLAN 1 O 3 MESES, SIN DUPLICADOS)
// =========================================================================
document.getElementById("applyPaymentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("paymentFeedback");
  feedback.className = "feedback";

  const storeId = document.getElementById("payStoreId").value.trim();
  const reference = document.getElementById("payRef").value.trim().toUpperCase();
  const months = Number(document.getElementById("payMonths").value) === 3 ? 3 : 1;
  const amount = document.getElementById("payAmount").value.trim() || "No especificado";
  const payDateStr = document.getElementById("payDate").value;

  try {
    const refDocRef = doc(db, PAYMENTS_COL, reference);
    const refSnap = await getDoc(refDocRef);
    if (refSnap.exists()) {
      const usedBy = refSnap.data().storeId;
      feedback.textContent = `Referencia "${reference}" DUPLICADA. Ya fue usada en el negocio "${usedBy}".`;
      feedback.classList.add("err");
      return;
    }

    const storeRef = doc(db, STORES_COL, storeId);
    const storeSnap = await getDoc(storeRef);
    if (!storeSnap.exists()) {
      feedback.textContent = `No existe ningún negocio con el ID "${storeId}".`;
      feedback.classList.add("err");
      return;
    }

    const storeData = storeSnap.data();
    const paymentDateObj = parseISODate(payDateStr) || new Date();
    const ingresoDateObj = getStoreIngresoDate(storeData) || paymentDateObj;
    const billingDay = getStoreBillingDay(storeData) || ingresoDateObj.getDate();
    const fechaIngresoFinal = storeData.fechaIngreso || toISODate(ingresoDateObj);
    const currentDue = getStoreDueDate(storeData);

    const baseForNext = (currentDue && currentDue > paymentDateObj) ? currentDue : paymentDateObj;
    const nextDueDate = addMonthsKeepingBillingDay(baseForNext, billingDay, months);
    const nextDueISO = isExemptStore(storeData) ? "Nunca" : toISODate(nextDueDate);

    await setDoc(refDocRef, {
      reference,
      storeId,
      ownerEmail: storeData.ownerEmail || "",
      planMonths: months,
      amount,
      fechaPago: payDateStr,
      nuevoVencimiento: nextDueISO,
      createdAt: serverTimestamp()
    });

    await updateDoc(storeRef, {
      fechaIngreso: fechaIngresoFinal,
      diaCobro: billingDay,
      status: "active",
      suspended: false,
      inhabilitada: false,
      activa: true,
      suspensionReason: "",
      lastPaymentRef: reference,
      lastPaymentDate: payDateStr,
      lastPlanMonths: months,
      paidUntil: nextDueDate.getTime(),
      trialEndsAt: nextDueDate.getTime(),
      proximoVencimiento: nextDueISO,
      updatedAt: serverTimestamp()
    });

    const planLabel = months === 3 ? "3 meses" : "1 mes";
    feedback.textContent = `Pago validado (${planLabel}, Ref: ${reference}). "${storeId}" ACTIVO (Vencimiento: ${nextDueISO}).`;
    feedback.classList.add("ok");
    e.target.reset();
    document.getElementById("payMonths").value = "1";
    document.getElementById("payDate").value = todayISO;
  } catch (err) {
    console.error(err);
    feedback.textContent = `Error al aplicar pago: ${err.message}`;
    feedback.classList.add("err");
  }
});

// =========================================================================
// BLOQUEO AUTOMÁTICO EN FIREBASE CUANDO LLEGA SU DÍA SIN PAGO
// =========================================================================
async function runAutomaticExpirationCheck() {
  const todayStr = toISODate(new Date());
  const todayObj = parseISODate(todayStr);
  let blockedCount = 0;

  for (const store of storesCache) {
    if (isExemptStore(store)) continue;
    if (store?.proximoVencimiento === "Nunca") continue;
    const dueObj = getStoreDueDate(store);
    if (!dueObj) continue;

    const isDueTodayOrPast = todayObj >= dueObj;
    const alreadyBlocked = isStoreBlocked(store);

    if (isDueTodayOrPast && !alreadyBlocked) {
      const storeRef = doc(db, STORES_COL, store.id);
      await updateDoc(storeRef, {
        status: "suspended",
        suspended: true,
        inhabilitada: true,
        activa: false,
        suspensionReason: `Vencimiento alcanzado (${toISODate(dueObj)}) sin pago registrado.`,
        updatedAt: serverTimestamp()
      });
      blockedCount++;
    }
  }
  return blockedCount;
}

btnRunAutoCheck.addEventListener("click", async () => {
  const count = await runAutomaticExpirationCheck();
  alert(count > 0
    ? `Revisión completada: se bloquearon ${count} negocio(s) vencido(s) en Firebase.`
    : "Revisión completada: no hay negocios vencidos pendientes por bloquear.");
});

window.toggleStoreBlock = async function (storeId, shouldBlock) {
  const docId = String(storeId);
  const store = storesCache.find((s) => s.id === docId || s.storeId === docId);
  const targetDocId = store?.id || docId;

  if (shouldBlock && store && isExemptStore(store)) {
    alert("Este correo está configurado como exento y no puede bloquearse.");
    return;
  }

  const storeRef = doc(db, STORES_COL, targetDocId);
  try {
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
      const billingDay = getStoreBillingDay(store) || new Date().getDate();
      const nextDueDate = addMonthsKeepingBillingDay(new Date(), billingDay, 1);
      const nextDueISO = isExemptStore(store) ? "Nunca" : toISODate(nextDueDate);
      await updateDoc(storeRef, {
        status: "active",
        suspended: false,
        inhabilitada: false,
        activa: true,
        suspensionReason: "",
        proximoVencimiento: nextDueISO,
        paidUntil: nextDueDate.getTime(),
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    console.error(err);
    const currentUid = auth.currentUser ? auth.currentUser.uid : "sin-usuario";
    alert(`Error (${currentUid} -> ${targetDocId}): ${err.message}`);
  }
};

// =========================================================================
// ESCUCHA EN TIEMPO REAL DESDE FIRESTORE
// =========================================================================
function startRealtimeListeners() {
  unsubStores = onSnapshot(collection(db, STORES_COL), async (snap) => {
    dbStatus.textContent = "Conectado a Firebase";
    dbStatus.className = "badge badge-ok";

    storesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

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

  unsubRefs = onSnapshot(collection(db, PAYMENTS_COL), (snap) => {
    refsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    document.getElementById("statRefs").textContent = refsCache.length;
    renderRefsTable();
  });
}

searchInput.addEventListener("input", renderStatsAndTables);

function renderStatsAndTables() {
  const query = searchInput.value.trim().toLowerCase();
  const total = storesCache.length;
  const blocked = storesCache.filter((s) => isStoreBlocked(s)).length;
  const active = total - blocked;

  document.getElementById("statTotal").textContent = total;
  document.getElementById("statActive").textContent = active;
  document.getElementById("statBlocked").textContent = blocked;

  const filtered = storesCache.filter((s) => {
    const bizLabel = getStoreName(s).toLowerCase();
    return (
      (s.id || "").toLowerCase().includes(query) ||
      (s.storeId || "").toLowerCase().includes(query) ||
      (s.ownerEmail || "").toLowerCase().includes(query) ||
      bizLabel.includes(query)
    );
  });

  if (filtered.length === 0) {
    storesTableBody.innerHTML = `<tr><td colspan="7" class="empty-row">No hay negocios que coincidan.</td></tr>`;
    return;
  }

  storesTableBody.innerHTML = filtered.map((s) => {
    const docId = s.id;
    const exempt = isExemptStore(s);
    const blocked = isStoreBlocked(s);
    const isTrial = !blocked && !exempt && s.status === "trial";
    const badgeClass = blocked ? "badge-bad" : (isTrial ? "badge-trial" : "badge-ok");
    const statusLabel = exempt
      ? "Activo (Exento)"
      : (blocked ? "Bloqueado" : (isTrial ? "Mes gratis (Activo)" : "Activo"));

    const ingresoDateObj = getStoreIngresoDate(s);
    const billingDay = getStoreBillingDay(s);
    const ingresoText = ingresoDateObj
      ? `${toISODate(ingresoDateObj)} (Día ${billingDay || ingresoDateObj.getDate()})`
      : "-";

    const dueDateObj = getStoreDueDate(s);
    const dueText = exempt || s.proximoVencimiento === "Nunca"
      ? "Nunca"
      : (dueDateObj ? toISODate(dueDateObj) : "-");

    return `
      <tr>
        <td><strong>${escapeHtml(docId)}</strong></td>
        <td>${escapeHtml(s.ownerEmail || "-")}</td>
        <td>${escapeHtml(getStoreName(s))}</td>
        <td>${escapeHtml(ingresoText)}</td>
        <td><strong>${escapeHtml(dueText)}</strong></td>
        <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
        <td class="actions-cell">
          ${exempt
            ? `<span class="hint">Protegido</span>`
            : (blocked
              ? `<button class="btn btn-success btn-sm" onclick="toggleStoreBlock('${escapeJs(docId)}', false)">Reactivar</button>`
              : `<button class="btn btn-danger btn-sm" onclick="toggleStoreBlock('${escapeJs(docId)}', true)">Bloquear</button>`
            )
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

  refsTableBody.innerHTML = refsCache.map((r) => {
    const planText = r.planMonths === 3 ? "3 meses" : (r.planMonths === 1 ? "1 mes" : "");
    const amountDisplay = planText ? `${planText} · ${r.amount || ""}` : (r.amount || "-");
    return `
      <tr>
        <td><strong>${escapeHtml(r.reference || r.id)}</strong></td>
        <td>${escapeHtml(r.storeId || "-")}</td>
        <td>${escapeHtml(amountDisplay)}</td>
        <td>${escapeHtml(r.fechaPago || "-")}</td>
        <td>${escapeHtml(r.nuevoVencimiento ? `Vence ${r.nuevoVencimiento}` : "Registrada")}</td>
      </tr>
    `;
  }).join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function escapeJs(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
