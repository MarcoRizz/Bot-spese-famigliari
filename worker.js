const CATEGORIES = [
  "🏠 Casa", "🛒 Spesa", "🍕 Ristorante", "⚕️ Salute", "✈️ Viaggi",
  "🍿 Tempo libero", "⚡ Bollette", "🏃 Sport", "🎁 Regali",
  "👠 Estetica", "🐕 Curry", "✨ Altro"
];

// ==============================
// ENTRY POINT
// ==============================

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    try {
      const update = await request.json();
      if (update.message) return await handleMessage(update.message, env);
      if (update.callback_query) return await handleCallback(update.callback_query, env);
    } catch (e) {
      console.error("Unhandled error:", e);
    }
    return new Response("ok");
  }
};

// ==============================
// MESSAGE HANDLER
// ==============================

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = `${chatId}_${userId}`;
  const text = (msg.text || "").trim();
  const userName = msg.from.first_name || "Utente";

  // /start
  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    await sendText(env, chatId,
      "👋 Ciao! Sono il bot per le spese di famiglia.\n\n" +
      "Comandi disponibili:\n" +
      "/spesa [importo] — Inserisci una spesa\n" +
      "/visualizza — Ultimi 10 inserimenti\n" +
      "/elimina — Elimina l'ultima spesa"
    );
    return new Response("ok");
  }

  // /spesa [args]
  if (text.startsWith("/spesa")) {
    const args = text.slice(6).trim();
    const expense = parseSpesaArgs(args);
    const { text: t, keyboard } = renderExpense(expense);
    const sent = await sendMessage(env, chatId, { text: t, keyboard });
    expense.mainMsgId = sent?.result?.message_id;
    await setState(env, key, expense);
    // Puliamo subito il comando dell'utente (in gruppo richiede diritti di admin, altrimenti resta)
    await deleteMessage(env, chatId, msg.message_id);
    return new Response("ok");
  }

  // /elimina
  if (text.startsWith("/elimina")) {
    try {
      const rows = await getSheetRows(env);
      if (rows.length <= 1) {
        await sendText(env, chatId, "📭 Non ci sono spese da eliminare.");
      } else {
        const last = rows[rows.length - 1];
        const desc = last[3] ? ` (${last[3]})` : "";
        await sendMessage(env, chatId, {
          text: `⚠️ Sei sicuro di voler eliminare l'ultima spesa?\n\n💰 ${last[1]}€ — ${last[2]}${desc}`,
          keyboard: {
            inline_keyboard: [[
              { text: "✅ Sì, elimina", callback_data: "confirm_delete" },
              { text: "❌ No, annulla", callback_data: "cancel_delete" }
            ]]
          }
        });
      }
    } catch (e) {
      await sendText(env, chatId, `❌ Errore: ${e.message}`);
    }
    return new Response("ok");
  }

  // /visualizza
  if (text.startsWith("/visualizza")) {
    try {
      const rows = await getSheetRows(env);
      if (rows.length <= 1) {
        await sendText(env, chatId, "📭 Il foglio è vuoto.");
      } else {
        const last10 = rows.slice(1).slice(-10);
        let out = "📋 Ultimi 10 inserimenti:\n\n";
        for (const row of last10) {
          out += `📅 ${row[4]} | 💰 ${row[1]}€\n`;
          out += `└ ${row[2]} (da ${row[7]})\n\n`;
        }
        await sendText(env, chatId, out);
      }
    } catch (e) {
      await sendText(env, chatId, `❌ Errore: ${e.message}`);
    }
    return new Response("ok");
  }

  // Non-command text — handle active expense session
  let expense = await getState(env, key);
  if (!expense) return new Response("ok");

  // Waiting for description
  if (expense.mode === "desc") {
    expense.description = text;
    delete expense.mode;
    await cleanupPrompt(env, chatId, expense, msg.message_id);
    delete expense.promptMsgId;
    expense = await refreshMainMessage(env, chatId, expense);
    await setState(env, key, expense);
    return new Response("ok");
  }

  // Waiting for amount (via pulsante "💰 Importo")
  if (expense.mode === "amount") {
    const match = text.match(/^\d+([.,]\d+)?$/);
    if (match) {
      expense.amount = parseFloat(text.replace(",", "."));
      delete expense.mode;
      await cleanupPrompt(env, chatId, expense, msg.message_id);
      delete expense.promptMsgId;
      expense = await refreshMainMessage(env, chatId, expense);
      await setState(env, key, expense);
    } else {
      await deleteMessage(env, chatId, msg.message_id);
      await editMessage(env, chatId, expense.promptMsgId, {
        text: "❌ Non è un numero valido. Rispondi qui con l'importo (es. 15.50):"
      });
    }
    return new Response("ok");
  }

  // Waiting for manual shares of "chi ha pagato"
  if (expense.mode === "paid_manual") {
    const shares = parseShares(text, PAID_NAMES);
    if (shares) {
      expense.paid_by = shares;
      expense.paid_manual = true;
      delete expense.mode;
      await cleanupPrompt(env, chatId, expense, msg.message_id);
      delete expense.promptMsgId;
      expense = await refreshMainMessage(env, chatId, expense);
      await setState(env, key, expense);
    } else {
      await deleteMessage(env, chatId, msg.message_id);
      await editMessage(env, chatId, expense.promptMsgId, {
        text: "❌ Formato non valido. Usa nomi tra Marco, Veronica, Conto, es.:\nMarco 60, Veronica 40"
      });
    }
    return new Response("ok");
  }

  // Waiting for manual shares di "riguarda"
  if (expense.mode === "ref_manual") {
    const shares = parseShares(text, REF_NAMES);
    if (shares) {
      expense.refer_to = shares;
      expense.refer_manual = true;
      delete expense.mode;
      await cleanupPrompt(env, chatId, expense, msg.message_id);
      delete expense.promptMsgId;
      expense = await refreshMainMessage(env, chatId, expense);
      await setState(env, key, expense);
    } else {
      await deleteMessage(env, chatId, msg.message_id);
      await editMessage(env, chatId, expense.promptMsgId, {
        text: "❌ Formato non valido. Usa nomi tra Marco, Veronica, es.:\nMarco 70, Veronica 30"
      });
    }
    return new Response("ok");
  }

  // Waiting for manual date (GG-MM)
  if (expense.mode === "date") {
    const match = text.match(/^(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      if (day < 1 || day > 31 || month < 1 || month > 12) {
        await deleteMessage(env, chatId, msg.message_id);
        await editMessage(env, chatId, expense.promptMsgId, {
          text: "❌ Data non valida. Rispondi qui con il formato GG-MM (es. 15-06):"
        });
        return new Response("ok");
      }
      const year = new Date().getFullYear();
      expense.date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      delete expense.mode;
      await cleanupPrompt(env, chatId, expense, msg.message_id);
      delete expense.promptMsgId;
      expense = await refreshMainMessage(env, chatId, expense);
      await setState(env, key, expense);
    } else {
      await deleteMessage(env, chatId, msg.message_id);
      await editMessage(env, chatId, expense.promptMsgId, {
        text: "❌ Usa il formato GG-MM (es. 15-06). Rispondi qui:"
      });
    }
    return new Response("ok");
  }

  // Bare number → aggiorna importo (comodo in chat privata; in gruppo funziona
  // solo se il messaggio è una risposta a un messaggio del bot, per via della
  // privacy mode di Telegram — per il gruppo usa il pulsante "💰 Importo")
  if (/^\d+([.,]\d+)?$/.test(text)) {
    expense.amount = parseFloat(text.replace(",", "."));
    await deleteMessage(env, chatId, msg.message_id);
    expense = await refreshMainMessage(env, chatId, expense);
    await setState(env, key, expense);
  }

  return new Response("ok");
}

// Cancella il prompt del bot e (se i permessi lo consentono) il messaggio dell'utente
async function cleanupPrompt(env, chatId, expense, userMsgId) {
  await deleteMessage(env, chatId, expense.promptMsgId);
  await deleteMessage(env, chatId, userMsgId);
}

// Ripubblica il messaggio del menu spesa come nuovo messaggio in fondo alla chat
// (cancellando quello vecchio), così resta sempre subito sotto l'ultima risposta.
async function refreshMainMessage(env, chatId, expense) {
  const oldMainMsgId = expense.mainMsgId;
  const { text: t, keyboard } = renderExpense(expense);
  const sent = await sendMessage(env, chatId, { text: t, keyboard });
  expense.mainMsgId = sent?.result?.message_id;
  await deleteMessage(env, chatId, oldMainMsgId);
  return expense;
}

// ==============================
// CALLBACK HANDLER
// ==============================

async function handleCallback(query, env) {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const userId = query.from.id;
  const key = `${chatId}_${userId}`;
  const data = query.data;
  const userName = query.from.first_name || "Utente";

  // ---- DELETE FLOW (no expense state needed) ----

  if (data === "confirm_delete") {
    await answerCallback(env, query.id);
    try {
      const rows = await getSheetRows(env);
      if (rows.length > 1) {
        const last = rows[rows.length - 1];
        await deleteLastSheetRow(env, rows.length);
        await editMessage(env, chatId, msgId, {
          text: `🗑️ Spesa eliminata: ${last[1]}€ — ${last[2]}`,
          keyboard: { inline_keyboard: [] }
        });
      } else {
        await editMessage(env, chatId, msgId, {
          text: "⚠️ Nulla da eliminare.",
          keyboard: { inline_keyboard: [] }
        });
      }
    } catch (e) {
      await editMessage(env, chatId, msgId, {
        text: `❌ Errore: ${e.message}`,
        keyboard: { inline_keyboard: [] }
      });
    }
    return new Response("ok");
  }

  if (data === "cancel_delete") {
    await answerCallback(env, query.id);
    await editMessage(env, chatId, msgId, {
      text: "Operazione annullata. La spesa è rimasta nel foglio.",
      keyboard: { inline_keyboard: [] }
    });
    return new Response("ok");
  }

  // ---- EXPENSE FLOW ----

  let expense = await getState(env, key);

  // Answer with alert if category missing on confirm
  if (data === "confirm" && expense && !expense.category) {
    await answerCallback(env, query.id, "⚠️ Seleziona prima una categoria!", true);
    return new Response("ok");
  }

  await answerCallback(env, query.id);

  if (!expense) return new Response("ok");

  // Cancel
  if (data === "cancel") {
    await deleteMessage(env, chatId, expense.promptMsgId);
    await deleteState(env, key);
    await editMessage(env, chatId, msgId, {
      text: "❌ Inserimento annullato.",
      keyboard: { inline_keyboard: [] }
    });
    return new Response("ok");
  }

  // Descrizione — richiede risposta testuale (force_reply)
  if (data === "edit_desc") {
    expense.mode = "desc";
    const prompt = await sendMessage(env, chatId, {
      text: "✍️ Rispondi a questo messaggio con la descrizione:",
      forceReply: true,
      replyToMessageId: msgId
    });
    expense.promptMsgId = prompt?.result?.message_id;
    await setState(env, key, expense);
    return new Response("ok");
  }

  // Importo — richiede risposta testuale (force_reply)
  if (data === "edit_amount") {
    expense.mode = "amount";
    const prompt = await sendMessage(env, chatId, {
      text: "✍️ Rispondi a questo messaggio con l'importo (es. 15.50):",
      forceReply: true,
      replyToMessageId: msgId
    });
    expense.promptMsgId = prompt?.result?.message_id;
    await setState(env, key, expense);
    return new Response("ok");
  }

  // Category menu
  if (data === "edit_cat") {
    const rows = [];
    for (let i = 0; i < CATEGORIES.length; i += 3) {
      rows.push(
        CATEGORIES.slice(i, i + 3).map(cat => ({ text: cat, callback_data: `cat:${cat}` }))
      );
    }
    rows.push([{ text: "🔙 Indietro", callback_data: "back" }]);
    await editMessage(env, chatId, msgId, {
      text: "📂 Seleziona categoria:",
      keyboard: { inline_keyboard: rows }
    });
    return new Response("ok");
  }

  if (data.startsWith("cat:")) {
    expense.category = data.slice(4);
  }

  // Paid-by menu
  if (data === "edit_paid") {
    await editMessage(env, chatId, msgId, {
      text: "💳 Chi ha pagato?",
      keyboard: {
        inline_keyboard: [
          [
            { text: "Conto", callback_data: "paid:Conto" },
            { text: "Marco", callback_data: "paid:Marco" },
            { text: "Veronica", callback_data: "paid:Veronica" }
          ],
          [{ text: "✏️ Quote manuali", callback_data: "paid_manual" }],
          [{ text: "🔙 Indietro", callback_data: "back" }]
        ]
      }
    });
    return new Response("ok");
  }

  if (data === "paid_manual") {
    expense.mode = "paid_manual";
    const prompt = await sendMessage(env, chatId, {
      text: "✍️ Rispondi con le quote di chi ha pagato (nomi validi: Marco, Veronica, Conto), ad esempio:\nMarco 60, Veronica 40",
      forceReply: true,
      replyToMessageId: msgId
    });
    expense.promptMsgId = prompt?.result?.message_id;
    await setState(env, key, expense);
    return new Response("ok");
  }

  if (data.startsWith("paid:")) {
    const who = data.slice(5);
    expense.paid_by = { [who]: 1 };
    delete expense.paid_manual;
  }

  // Refer-to menu
  if (data === "edit_ref") {
    await editMessage(env, chatId, msgId, {
      text: "👥 A chi si riferisce la spesa?",
      keyboard: {
        inline_keyboard: [
          [
            { text: "Entrambi (ordinaria)", callback_data: "ref:ordinaria" },
            { text: "Entrambi (straordinaria)", callback_data: "ref:straordinaria" }
          ],
          [
            { text: "Marco", callback_data: "ref:Marco" },
            { text: "Veronica", callback_data: "ref:Veronica" }
          ],
          [{ text: "✏️ Quote manuali", callback_data: "ref_manual" }],
          [{ text: "🔙 Indietro", callback_data: "back" }]
        ]
      }
    });
    return new Response("ok");
  }

  if (data === "ref_manual") {
    expense.mode = "ref_manual";
    const prompt = await sendMessage(env, chatId, {
      text: "✍️ Rispondi con le quote di chi riguarda la spesa (nomi validi: Marco, Veronica), ad esempio:\nMarco 70, Veronica 30",
      forceReply: true,
      replyToMessageId: msgId
    });
    expense.promptMsgId = prompt?.result?.message_id;
    await setState(env, key, expense);
    return new Response("ok");
  }

  if (data.startsWith("ref:")) {
    const who = data.slice(4);
    delete expense.refer_manual;
    if (who === "ordinaria") {
      expense.refer_to = { ordinaria: 1 };
    } else if (who === "straordinaria") {
      expense.refer_to = { Marco: 1, Veronica: 1 };
    } else {
      expense.refer_to = { [who]: 1 };
    }
  }

  // Date menu — bottoni rapidi + risposta testuale libera (force_reply)
  if (data === "edit_date") {
    expense.mode = "date";
    await editMessage(env, chatId, msgId, {
      text: "📅 Quando è avvenuta la spesa?\n(Oppure rispondi al prossimo messaggio con GG-MM)",
      keyboard: {
        inline_keyboard: [
          [
            { text: "Oggi", callback_data: "date:today" },
            { text: "Ieri", callback_data: "date:yesterday" }
          ],
          [{ text: "🔙 Indietro", callback_data: "back" }]
        ]
      }
    });
    const prompt = await sendMessage(env, chatId, {
      text: "✍️ Oppure rispondi qui con la data (formato GG-MM):",
      forceReply: true,
      replyToMessageId: msgId
    });
    expense.promptMsgId = prompt?.result?.message_id;
    await setState(env, key, expense);
    return new Response("ok");
  }

  if (data === "date:today") {
    expense.date = todayISO();
    delete expense.mode;
    await deleteMessage(env, chatId, expense.promptMsgId);
    delete expense.promptMsgId;
  }

  if (data === "date:yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    expense.date = d.toISOString().slice(0, 10);
    delete expense.mode;
    await deleteMessage(env, chatId, expense.promptMsgId);
    delete expense.promptMsgId;
  }

  // Confirm & save
  if (data === "confirm") {
    await deleteMessage(env, chatId, expense.promptMsgId);
    try {
      await saveExpense(env, expense, userName);
      await deleteState(env, key);
      const finalText =
        `✅ SPESA REGISTRATA\n` +
        `———————————\n` +
        `💰 ${expense.amount.toFixed(2)} €\n` +
        `📂 ${expense.category}\n` +
        `📝 ${expense.description || "—"}\n` +
        `📅 ${formatDate(expense.date)}\n` +
        `💳 ${renderPaidBy(expense.paid_by, expense.paid_manual)}\n` +
        `👥 ${renderReferTo(expense.refer_to, expense.refer_manual)}\n` +
        `👤 ${userName}`;
      await editMessage(env, chatId, msgId, {
        text: finalText,
        keyboard: { inline_keyboard: [] }
      });
    } catch (e) {
      await editMessage(env, chatId, msgId, {
        text: `❌ Errore nel salvataggio: ${e.message}`,
        keyboard: { inline_keyboard: [] }
      });
    }
    return new Response("ok");
  }

  // Back — chiude eventuale prompt testuale pendente e ridisegna il menu
  if (data === "back") {
    if (expense.mode) {
      await deleteMessage(env, chatId, expense.promptMsgId);
      delete expense.promptMsgId;
    }
    delete expense.mode;
  }

  // Re-render main expense view (fallthrough for cat:, paid:, ref:, date:*, back)
  await setState(env, key, expense);
  const { text, keyboard } = renderExpense(expense);
  await editMessage(env, chatId, msgId, { text, keyboard });
  return new Response("ok");
}

// ==============================
// EXPENSE UTILITIES
// ==============================

function createDefaultExpense() {
  return {
    amount: 0,
    category: null,
    description: null,
    date: todayISO(),
    paid_by: { Conto: 1 },
    refer_to: { ordinaria: 1 }
  };
}

function parseSpesaArgs(args) {
  const expense = createDefaultExpense();
  if (!args) return expense;

  let remaining = args;

  // 1. Data: parole chiave "oggi"/"ieri", oppure formato GG-MM o GG/MM.
  //    Va estratta prima dell'importo per non confondere "12-06" con un numero.
  const dateWordMatch = remaining.match(/\b(oggi|ieri)\b/i);
  if (dateWordMatch) {
    if (dateWordMatch[1].toLowerCase() === "ieri") {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      expense.date = d.toISOString().slice(0, 10);
    }
    // "oggi" è già il default impostato da createDefaultExpense
    remaining = remaining.replace(dateWordMatch[0], "").trim();
  } else {
    const dateMatch = remaining.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const year = new Date().getFullYear();
        expense.date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        remaining = remaining.replace(dateMatch[0], "").trim();
      }
    }
  }

  // 2. Importo
  const amountMatch = remaining.match(/(\d+(?:[.,]\d+)?)/);
  if (amountMatch) {
    expense.amount = parseFloat(amountMatch[1].replace(",", "."));
    remaining = remaining.replace(amountMatch[1], "").trim();
  }

  // 3. Categoria: se più categorie compaiono nel testo, vince quella scritta per prima
  //    (in base alla posizione nel testo, non all'ordine dell'array CATEGORIES)
  const lowerRemaining = remaining.toLowerCase();
  let bestIndex = Infinity;
  let bestCat = null;
  let bestKey = null;
  for (const cat of CATEGORIES) {
    const catKey = cat.replace(/[^a-zA-ZÀ-ÿ0-9]/g, "").toLowerCase();
    if (!catKey) continue;
    const idx = lowerRemaining.indexOf(catKey);
    if (idx !== -1 && idx < bestIndex) {
      bestIndex = idx;
      bestCat = cat;
      bestKey = catKey;
    }
  }
  if (bestCat) {
    expense.category = bestCat;
    remaining = remaining.replace(new RegExp(bestKey, "i"), "").trim();
  }

  // Remaining text is description
  const desc = remaining.replace(/^[\s\-]+/, "").replace(/\s{2,}/g, " ").trim();
  expense.description = desc || null;
  return expense;
}

const PAID_NAMES = ["Marco", "Veronica", "Conto"];
const REF_NAMES = ["Marco", "Veronica"];

// Interpreta un testo tipo "Marco 60, Veronica 40" in { Marco: 60, Veronica: 40 }.
// Ritorna null se il testo non è valido o contiene nomi non ammessi.
function parseShares(text, allowedNames) {
  const parts = text.split(/[,\n]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const result = {};
  for (const part of parts) {
    const m = part.match(/^([A-Za-zÀ-ÿ]+)\s+(\d+(?:[.,]\d+)?)\s*%?$/);
    if (!m) return null;
    const canonical = allowedNames.find(n => n.toLowerCase() === m[1].toLowerCase());
    const value = parseFloat(m[2].replace(",", "."));
    if (!canonical || !(value > 0)) return null;
    result[canonical] = (result[canonical] || 0) + value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Mostra le quote come percentuali, es. "Marco 60% + Veronica 40%"
function renderShares(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "—";
  if (keys.length === 1) return keys[0];
  const total = keys.reduce((sum, k) => sum + Number(obj[k]), 0) || 1;
  return keys.map(k => `${k} ${Math.round((Number(obj[k]) / total) * 100)}%`).join(" + ");
}

function renderPaidBy(paid_by, manual) {
  if (manual) return renderShares(paid_by);
  const keys = Object.keys(paid_by);
  return keys.length === 1 ? keys[0] : keys.join(" + ");
}

function renderReferTo(refer_to, manual) {
  if (manual) return renderShares(refer_to);
  if (refer_to.ordinaria) return "Entrambi (ordinaria)";
  const keys = Object.keys(refer_to);
  if (keys.length === 2) return "Entrambi (straordinaria)";
  return keys[0] || "—";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "oggi";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function renderExpense(expense) {
  const text =
    `💰 ${expense.amount.toFixed(2)} €\n\n` +
    `📂 Categoria: ${expense.category || "❓"}\n` +
    `📝 Descrizione: ${expense.description || "—"}\n` +
    `📅 Data: ${formatDate(expense.date)}\n\n` +
    `💳 Pagato da: ${renderPaidBy(expense.paid_by, expense.paid_manual)}\n` +
    `👥 Riguarda: ${renderReferTo(expense.refer_to, expense.refer_manual)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "💰 Importo", callback_data: "edit_amount" },
        { text: "📂 Categoria", callback_data: "edit_cat" }
      ],
      [
        { text: "📝 Descrizione", callback_data: "edit_desc" }
      ],
      [
        { text: "💳 Pagato", callback_data: "edit_paid" },
        { text: "👥 Riguarda", callback_data: "edit_ref" }
      ],
      [{ text: "📅 Data", callback_data: "edit_date" }],
      [{ text: "✅ CONFERMA E SALVA", callback_data: "confirm" }],
      [{ text: "❌ ANNULLA", callback_data: "cancel" }]
    ]
  };

  return { text, keyboard };
}

// ==============================
// GOOGLE SHEETS
// ==============================

async function getGoogleToken(env) {
  // Reuse cached token if still valid (expires 2 min early for safety)
  const cached = await env.USER_STATE.get("__gtoken__");
  if (cached) {
    const { token, exp } = JSON.parse(cached);
    if (Date.now() / 1000 < exp - 120) return token;
  }

  const creds = JSON.parse(env.GOOGLE_CREDENTIALS);
  const now = Math.floor(Date.now() / 1000);

  const b64url = obj =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });

  const sigInput = `${header}.${payload}`;

  const pemBody = creds.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/[\r\n]/g, "");
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const jwt = `${sigInput}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await res.json();
  if (!tokenData.access_token) {
    throw new Error("Token Google fallito: " + JSON.stringify(tokenData));
  }

  // Cache in KV for ~58 minutes
  await env.USER_STATE.put(
    "__gtoken__",
    JSON.stringify({ token: tokenData.access_token, exp: now + 3600 }),
    { expirationTtl: 3500 }
  );

  return tokenData.access_token;
}

async function getSheetRows(env) {
  const token = await getGoogleToken(env);
  const sheetName = env.SHEET_NAME || "Sheet1";
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(sheetName)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.values || [];
}

async function saveExpense(env, expense, userName) {
  const token = await getGoogleToken(env);
  const sheetName = env.SHEET_NAME || "Sheet1";
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // Column order: timestamp | amount | category | description | date | paid_by | refer_to | user
  const row = [
    now,
    expense.amount,
    expense.category,
    expense.description || "",
    formatDate(expense.date),
    JSON.stringify(expense.paid_by),
    JSON.stringify(expense.refer_to),
    userName
  ];

  const range = encodeURIComponent(`${sheetName}!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: [row] })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
}

async function deleteLastSheetRow(env, totalRows) {
  const token = await getGoogleToken(env);

  // Get numeric sheet ID from metadata
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaRes.json();
  if (meta.error) throw new Error(meta.error.message);
  const sheetNumId = meta.sheets[0].properties.sheetId;

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetNumId,
              dimension: "ROWS",
              startIndex: totalRows - 1,
              endIndex: totalRows
            }
          }
        }]
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
}

// ==============================
// TELEGRAM API
// ==============================

async function tgFetch(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // risposta non JSON: la ignoriamo
  }
  if (!res.ok) {
    console.error(`Telegram ${method} error:`, data || res.status);
  }
  return data;
}

async function sendText(env, chatId, text) {
  return await tgFetch(env, "sendMessage", { chat_id: chatId, text });
}

async function sendMessage(env, chatId, payload) {
  const body = { chat_id: chatId, text: payload.text };
  if (payload.keyboard) body.reply_markup = payload.keyboard;
  if (payload.forceReply) body.reply_markup = { force_reply: true };
  if (payload.replyToMessageId) body.reply_to_message_id = payload.replyToMessageId;
  if (payload.parse_mode) body.parse_mode = payload.parse_mode;
  return await tgFetch(env, "sendMessage", body);
}

async function editMessage(env, chatId, msgId, payload) {
  if (!msgId) return null;
  const body = { chat_id: chatId, message_id: msgId, text: payload.text };
  if (payload.keyboard) body.reply_markup = payload.keyboard;
  if (payload.parse_mode) body.parse_mode = payload.parse_mode;
  return await tgFetch(env, "editMessageText", body);
}

async function deleteMessage(env, chatId, messageId) {
  if (!messageId) return null;
  // Cancellare messaggi del bot funziona sempre; cancellare messaggi altrui in un
  // gruppo richiede che il bot sia admin con permesso "Elimina messaggi" — se manca
  // il permesso, la chiamata fallisce silenziosamente (l'errore viene solo loggato).
  return await tgFetch(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function answerCallback(env, callbackId, text = null, showAlert = false) {
  const body = { callback_query_id: callbackId };
  if (text) { body.text = text; body.show_alert = showAlert; }
  await tgFetch(env, "answerCallbackQuery", body);
}

// ==============================
// KV STATE
// ==============================

async function getState(env, key) {
  const data = await env.USER_STATE.get(key);
  return data ? JSON.parse(data) : null;
}

async function setState(env, key, value) {
  // Sessions expire after 24h of inactivity
  await env.USER_STATE.put(key, JSON.stringify(value), { expirationTtl: 86400 });
}

async function deleteState(env, key) {
  await env.USER_STATE.delete(key);
}