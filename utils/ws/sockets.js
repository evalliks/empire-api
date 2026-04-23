const { XMLParser } = require('fast-xml-parser');
const { GgeSocket } = require('./ggeSocket');
const { E4kSocket } = require('./e4kSocket');
const { getActiveBots } = require('../firestoreService');

const parser = new XMLParser();

// Mapas de zonas → URL de WebSocket, construídos uma vez na inicialização
// e atualizados periodicamente para descobrir novos servidores.
let ggeServerMap = {}; // { "EmpireEx_1": { url: "wss://...", networkId: 1 }, ... }
let e4kServerMap = {}; // { "zoneName": "ws://...", ... }

async function buildGgeServerMap() {
    const networksIds = [1, 5, 11, 26, 34, 39, 64, 65, 68];
    const map = {};
    for (const networkId of networksIds) {
        try {
            const response = await fetch(
                `https://media.goodgamestudios.com/games-config/network/12/live/${networkId}.xml`,
                { signal: AbortSignal.timeout(60 * 1000) }
            );
            const data = parser.parse(await response.text());
            let instances = data.network.instances.instance;
            if (!Array.isArray(instances)) instances = [instances];
            for (const server of instances) {
                if (server.zone !== "EmpireEx_23") {
                    map[server.zone] = { url: `wss://${server.server}`, networkId };
                }
            }
        } catch (err) {
            console.error(`Falha ao buscar GGE network ${networkId}:`, err.message);
        }
    }
    return map;
}

async function buildE4kServerMap() {
    const networksIds = [72, 77];
    const map = {};
    for (const networkId of networksIds) {
        try {
            const response = await fetch(
                `https://media.goodgamestudios.com/games-config/network/16/live/${networkId}.xml`,
                { signal: AbortSignal.timeout(60 * 1000) }
            );
            const data = parser.parse(await response.text());
            let instances = data.network.instances.instance;
            if (!Array.isArray(instances)) instances = [instances];
            for (const server of instances) {
                map[server.zone] = `ws://${server.server}`;
            }
        } catch (err) {
            console.error(`Falha ao buscar E4K network ${networkId}:`, err.message);
        }
    }
    return map;
}

/**
 * Atualiza os mapas de servidores GGE e E4K.
 * Chamado no startup e periodicamente para detectar novos servidores.
 */
async function refreshServerMaps() {
    [ggeServerMap, e4kServerMap] = await Promise.all([buildGgeServerMap(), buildE4kServerMap()]);
    console.log(`Servidores GGE: ${Object.keys(ggeServerMap).length} | E4K: ${Object.keys(e4kServerMap).length}`);
}

/**
 * Cria um socket para um bot usando seus dados do Firestore.
 * Usa ggeServerMap e e4kServerMap para encontrar a URL do servidor.
 * @param {object} bot - Dados do bot do Firestore
 * @returns {GgeSocket|E4kSocket|null}
 */
function createSocketForBot(bot) {
    const { id, server, gameName, gamePassword } = bot;

    if (!server || !gameName || !gamePassword) {
        console.warn(`Bot ${id} sem server/gameName/gamePassword — ignorado.`);
        return null;
    }

    if (server in ggeServerMap) {
        const { url, networkId } = ggeServerMap[server];
        console.log(`Criando GgeSocket para bot ${id} → ${server}`);
        return new GgeSocket(url, server, gameName, gamePassword, networkId, id);
    }

    if (server in e4kServerMap) {
        const url = e4kServerMap[server];
        console.log(`Criando E4kSocket para bot ${id} → ${server}`);
        return new E4kSocket(url, server, gameName, gamePassword, id);
    }

    console.warn(`Bot ${id}: servidor "${server}" não encontrado nos mapas GGE/E4K.`);
    return null;
}

/**
 * Carrega todos os bots ativos do Firestore e cria seus sockets.
 * Retorna um objeto { botId: GgeSocket|E4kSocket }.
 */
async function getSockets() {
    await refreshServerMaps();

    const bots = await getActiveBots();
    console.log(`Bots ativos no Firestore: ${bots.length}`);

    const sockets = {};
    for (const bot of bots) {
        const socket = createSocketForBot(bot);
        if (socket) sockets[bot.id] = socket;
    }
    return sockets;
}

/**
 * Conecta todos os sockets.
 */
function connectSockets(sockets) {
    for (const [botId, socket] of Object.entries(sockets)) {
        console.log(`Conectando socket do bot ${botId}...`);
        socket.connect();
    }
}

/**
 * Reinicia todos os sockets (chamado diariamente).
 */
function restartSockets(sockets) {
    for (const socket of Object.values(sockets)) {
        socket.restart();
    }
}

module.exports = {
    getSockets,
    connectSockets,
    restartSockets,
    refreshServerMaps,
    createSocketForBot,
    get ggeServerMap() { return ggeServerMap; },
    get e4kServerMap() { return e4kServerMap; },
};
