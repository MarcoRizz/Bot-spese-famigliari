import os
import gspread
from google.oauth2.service_account import Credentials
import json
from datetime import datetime
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)

TOKEN = os.getenv("BOT_TOKEN")

CATEGORIES = ["🏠Casa", "🛒Spesa", "🍕Ristorante", "⚕️Salute", "✈️Viaggi", "🍿Tempo libero", "⚡Bollette", "🏃Sport", "🎁Regali", "👠Estetica", "🐕Curry", "✨Altro"]

user_states = {}

# -----------------------------
# CONFIG GOOGLE SHEETS
# -----------------------------
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
creds_dict = json.loads(os.getenv("GOOGLE_CREDENTIALS"))

credentials = Credentials.from_service_account_info(
    creds_dict,
    scopes=SCOPES
)

gc = gspread.authorize(credentials)

SHEET_ID = os.getenv("SHEET_ID")
sheet = gc.open_by_key(SHEET_ID).sheet1

# -----------------------------
# Utility
# -----------------------------

def default_expense(user_name):
    return {
        "amount": None,
        "category": None,
        "date": datetime.today(),
        "paid_by": {
            "Marco": 1,
            "Veronica": 1,
        },
        "refer_to": {
            "Marco": 1,
            "Veronica": 1,
        },
    }

def percentage_map(d):
    total = sum(d.values())
    if total == 0:
        return {k: 0 for k in d}
    return {k: round(v / total * 100) for k, v in d.items()}

def render_expense(expense):
    paid_pct = percentage_map(expense["paid_by"])
    ref_pct = percentage_map(expense["refer_to"])

    text = f"💰 *{expense['amount']:.2f} €*\n"
    text += f"📂 {expense['category'] or '❓'}\n"
    text += f"📅 {expense['date'].strftime('%d-%m-%Y')}\n\n"
    
    p_str = ", ".join([f"{k}" for k, v in paid_pct.items() if v > 0])
    r_str = "Entrambi" if all(v > 0 for v in ref_pct.values()) else ", ".join([f"{k}" for k, v in ref_pct.items() if v > 0])
    
    text += f"💳 Pagato da: {p_str}\n"
    text += f"👥 Riguarda: {r_str}\n"

    keyboard = [
        [
            InlineKeyboardButton("📂 Categoria", callback_data="edit_cat"),
            InlineKeyboardButton("📅 Data", callback_data="edit_date")
        ],
        [
            InlineKeyboardButton("💳 Pagato", callback_data="edit_paid"),
            InlineKeyboardButton("👥 Riguarda", callback_data="edit_ref")
        ],
        [InlineKeyboardButton("✅ CONFERMA E SALVA", callback_data="confirm")],
        [InlineKeyboardButton("❌ ANNULLA", callback_data="cancel")] # Pulsante Annulla
    ]

    return text, InlineKeyboardMarkup(keyboard)

def save_expense(expense, user_name):
    row = [
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),  # Timestamp
        f"{expense['amount']:.2f}",                   # Importo
        expense["category"],                           # Categoria
        expense["date"].strftime("%d-%m-%Y"),         # Data
        json.dumps(expense["paid_by"]),               # Paid_by
        json.dumps(expense["refer_to"]),             # Refer_to
        user_name                                     # Inserito_da
    ]
    sheet.append_row(row)

async def delete_last(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Chiede conferma prima di eliminare l'ultima riga"""
    try:
        all_rows = sheet.get_all_values()
        if len(all_rows) > 1:
            last_data = all_rows[-1]
            # Formattiamo un piccolo riepilogo per far capire cosa si sta eliminando
            riepilogo = f"💰 {last_data[1]}€ - {last_data[2]} ({last_data[3]})"
            
            keyboard = [
                [
                    InlineKeyboardButton("✅ Sì, elimina", callback_data="confirm_delete"),
                    InlineKeyboardButton("❌ No, annulla", callback_data="back_to_menu")
                ]
            ]
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            await update.message.reply_text(
                f"⚠️ **Sei sicuro di voler eliminare l'ultima spesa?**\n\n{riepilogo}",
                reply_markup=reply_markup,
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text("📭 Non ci sono spese da eliminare.")
    except Exception as e:
        await update.message.reply_text(f"❌ Errore: {e}")

async def list_expenses(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Visualizza le ultime 10 spese registrate"""
    try:
        all_rows = sheet.get_all_values()
        if len(all_rows) <= 1:
            await update.message.reply_text("📭 Il foglio è vuoto.")
            return

        # Prende le ultime 10 righe (escludendo l'intestazione)
        last_10 = all_rows[1:][-10:]
        
        msg = "📋 **Ultimi 10 inserimenti:**\n\n"
        for row in last_10:
            # row[3] = data, row[1] = importo, row[2] = cat, row[6] = chi
            msg += f"📅 `{row[3]}` | 💰 **{row[1]}€**\n"
            msg += f"└ {row[2]} (da {row[6]})\n\n"
        
        await update.message.reply_text(msg, parse_mode="Markdown")
    except Exception as e:
        await update.message.reply_text(f"❌ Errore nel recupero dati: {e}")

# -----------------------------
# Handlers
# -----------------------------

async def start_expense(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Prende gli argomenti dopo il comando (es. /spesa 15.50)
    if not context.args:
        await update.message.reply_text("❌ Errore: usa il comando seguito dall'importo.\nEsempio: `/spesa 15.50`", parse_mode="Markdown")
        return

    try:
        amount_str = context.args[0].replace(",", ".")
        amount = float(amount_str)
    except ValueError:
        await update.message.reply_text("❌ Importo non valido. Usa i numeri (es. 10.50).")
        return

    user_name = update.message.from_user.first_name
    expense = default_expense(user_name)
    expense["amount"] = amount
    
    key = (update.effective_chat.id, update.effective_user.id)
    user_states[key] = expense

    text_resp, keyboard = render_expense(expense)
    await update.message.reply_text(text_resp, reply_markup=keyboard, parse_mode="Markdown")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    key = (update.effective_chat.id, update.effective_user.id)
    expense = user_states.get(key)

    # Gestisce SOLO l'inserimento della data se attivato dal menu
    if expense and expense.get("waiting_for_date"):
        try:
            day, month = map(int, text.split('-'))
            new_date = datetime(datetime.now().year, month, day)
            expense["date"] = new_date
            expense.pop("waiting_for_date", None)
            
            text_resp, keyboard = render_expense(expense)
            await update.message.reply_text(text_resp, reply_markup=keyboard, parse_mode="Markdown")
        except ValueError:
            await update.message.reply_text("❌ Usa il formato GG-MM.")

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    
    # --- LOGICA ELIMINAZIONE ---
    if data == "confirm_delete":
        try:
            all_rows = sheet.get_all_values()
            if len(all_rows) > 1:
                last_data = all_rows[-1]
                sheet.delete_rows(len(all_rows))
                await query.edit_message_text(f"🗑️ Eliminata con successo: {last_data[1]}€")
            else:
                await query.edit_message_text("⚠️ Nulla da eliminare.")
        except Exception as e:
            await query.edit_message_text(f"❌ Errore durante l'eliminazione: {e}")
        return

    if data == "back_to_menu":
        await query.edit_message_text("Operazione annullata. La spesa è rimasta nel foglio.")
        return

    # --- LOGICA ESISTENTE (Spesa in corso) ---
    key = (update.effective_chat.id, update.effective_user.id)
    expense = user_states.get(key)
    
    # Se l'utente clicca un pulsante di modifica ma la sessione è scaduta
    if not expense:
        # Se non è una delle callback di eliminazione sopra, ignoriamo o avvisiamo
        return

    # --- ANNULLA TUTTO ---
    if data == "cancel":
        user_states.pop(key, None)
        await query.edit_message_text("❌ Inserimento annullato.")
        return

    # --- DATA ---
    if data == "edit_date":
        expense["waiting_for_date"] = True
        keyboard = [
            [
                InlineKeyboardButton("Oggi", callback_data="set_date:today"),
                InlineKeyboardButton("Ieri", callback_data="set_date:yesterday")
            ],
            [InlineKeyboardButton("🔙 Indietro", callback_data="back")]
        ]
        await query.edit_message_text("📅 Quando è avvenuta la spesa?\n(Oppure scrivi `GG-MM`)", 
                                      reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    if data.startswith("set_date:"):
        from datetime import timedelta
        expense["date"] = datetime.today() if "today" in data else datetime.today() - timedelta(days=1)
        expense.pop("waiting_for_date", None)

    # --- CATEGORIE ---
    if data == "edit_cat":
        keyboard = []
        for i in range(0, len(CATEGORIES), 3):
            row = [InlineKeyboardButton(cat, callback_data=f"cat:{cat}") for cat in CATEGORIES[i:i+3]]
            keyboard.append(row)
        keyboard.append([InlineKeyboardButton("🔙 Indietro", callback_data="back")])
        await query.edit_message_text("Seleziona categoria:", reply_markup=InlineKeyboardMarkup(keyboard))
        return
    
    if data.startswith("cat:"):
        expense["category"] = data.split(":")[1]

    # --- PAGATO DA ---
    if data == "edit_paid":
        keyboard = [
            [
                InlineKeyboardButton("Marco", callback_data="paid:Marco"),
                InlineKeyboardButton("Veronica", callback_data="paid:Veronica"),
                InlineKeyboardButton("50/50", callback_data="paid:equal")
            ],
            [InlineKeyboardButton("🔙 Indietro", callback_data="back")]
        ]
        await query.edit_message_text("Chi ha pagato?", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    if data.startswith("paid:"):
        mode = data.split(":")[1]
        expense["paid_by"] = {"Marco": 1, "Veronica": 1} if mode == "equal" else {"Marco": 0, "Veronica": 0}
        if mode != "equal": expense["paid_by"][mode] = 1

    # --- RIGUARDA (Sistemato) ---
    if data == "edit_ref":
        keyboard = [
            [
                InlineKeyboardButton("Marco", callback_data="ref:Marco"),
                InlineKeyboardButton("Veronica", callback_data="ref:Veronica"),
                InlineKeyboardButton("Entrambi", callback_data="ref:equal")
            ],
            [InlineKeyboardButton("🔙 Indietro", callback_data="back")]
        ]
        await query.edit_message_text("A chi si riferisce la spesa?", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    if data.startswith("ref:"):
        mode = data.split(":")[1]
        expense["refer_to"] = {"Marco": 1, "Veronica": 1} if mode == "equal" else {"Marco": 0, "Veronica": 0}
        if mode != "equal": expense["refer_to"][mode] = 1

    # --- CONFERMA ---
    if data == "confirm":
        if not expense["category"]:
            await query.answer("⚠️ Categoria obbligatoria!", show_alert=True)
            return
        
        # Salvataggio
        save_expense(expense, query.from_user.first_name)
        
        # 1) MODIFICA CONFERMA: Resta il riepilogo senza pulsanti
        final_text = (
            f"✅ **SPESA REGISTRATA**\n"
            f"-------------------\n"
            f"💰 Importo: {expense['amount']:.2f} €\n"
            f"📂 Categoria: {expense['category']}\n"
            f"📅 Data: {expense['date'].strftime('%d-%m-%Y')}\n"
            f"👤 Inserita da: {query.from_user.first_name}"
        )
        await query.edit_message_text(final_text, parse_mode="Markdown")
        
        user_states.pop(key, None)
        return

    # --- BACK / RENDER ---
    if data == "back":
        expense.pop("waiting_for_date", None)
    
    text, keyboard = render_expense(expense)
    try:
        await query.edit_message_text(text, reply_markup=keyboard, parse_mode="Markdown")
    except: pass

# -----------------------------
# Main
# -----------------------------

if __name__ == "__main__":
    PORT = int(os.getenv("PORT", 10000))
    RENDER_EXTERNAL_HOSTNAME = os.getenv("RENDER_EXTERNAL_HOSTNAME")
    
    app = ApplicationBuilder().token(TOKEN).build()

    # Comandi
    app.add_handler(CommandHandler("spesa", start_expense))
    app.add_handler(CommandHandler("elimina", delete_last))
    app.add_handler(CommandHandler("visualizza", list_expenses))
    
    # Messaggi e Callback
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(handle_callback))

    print("Bot in ascolto...")
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        webhook_url=f"https://{RENDER_EXTERNAL_HOSTNAME}/",
    )