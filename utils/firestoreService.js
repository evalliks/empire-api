const admin = require('firebase-admin');

// Suporte a credenciais via variável de ambiente ou Application Default Credentials
const credential = process.env.FIREBASE_SERVICE_ACCOUNT
    ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : admin.credential.applicationDefault();

admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID,
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/**
 * Retorna todos os bots ativos (isOn: true) do Firestore.
 */
async function getActiveBots() {
    const snap = await db.collection('bots').where('isOn', '==', true).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Escuta mudanças na coleção de bots em tempo real.
 * @param {function} callback - (type: 'added'|'modified'|'removed', bot: object) => void
 * @returns {function} unsubscribe
 */
function onBotsChange(callback) {
    return db.collection('bots').onSnapshot(snap => {
        snap.docChanges().forEach(change => {
            const bot = { id: change.doc.id, ...change.doc.data() };
            callback(change.type, bot);
        });
    }, err => {
        console.error('Firestore onBotsChange error:', err.message);
    });
}

/**
 * Atualiza o status de conexão de um bot no Firestore.
 */
async function setBotConnected(botId, connected) {
    try {
        await db.collection('bots').doc(botId).update({
            connected,
            lastStatusAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
        console.error(`Firestore setBotConnected(${botId}) error:`, err.message);
    }
}

/**
 * Sincroniza os dados do jogo vindos da resposta do comando gpi.
 * Extrai os campos conhecidos do protocolo GGE/E4K e salva no Firestore.
 */
async function syncBotGameData(botId, gpiData) {
    try {
        const update = {
            connected: true,
            lastSyncAt: FieldValue.serverTimestamp(),
        };

        if (gpiData && typeof gpiData === 'object') {
            // Campos comuns do protocolo GGE
            if ('RES' in gpiData)  update.gold         = gpiData.RES;
            if ('RUBY' in gpiData) update.rubies        = gpiData.RUBY;
            if ('R'    in gpiData) update.rubies        = gpiData.R;
            if ('ATK'  in gpiData) update.dailyAttacks  = gpiData.ATK;
            if ('N'    in gpiData) update.gameName      = gpiData.N;
            if ('OID'  in gpiData) update.gameOid       = gpiData.OID;
            if ('AID'  in gpiData) update.allianceId    = gpiData.AID;

            // Campos do protocolo E4K (core_lga / gpi)
            if ('GOLD' in gpiData) update.gold         = gpiData.GOLD;
            if ('GEM'  in gpiData) update.rubies        = gpiData.GEM;
            if ('UID'  in gpiData) update.gameOid       = gpiData.UID;

            // Guarda o snapshot bruto (truncado) para depuração
            update.lastGpiSnapshot = JSON.stringify(gpiData).substring(0, 2000);
        }

        await db.collection('bots').doc(botId).update(update);
    } catch (err) {
        console.error(`Firestore syncBotGameData(${botId}) error:`, err.message);
    }
}

module.exports = {
    getActiveBots,
    onBotsChange,
    setBotConnected,
    syncBotGameData,
};
