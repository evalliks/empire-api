const express = require('express');
const commands = require('./data/commands.json');
const { setNestedValue } = require('./utils/nestedHeaders');
const { verifyBot, discoverBotServer } = require('./utils/verifyBot');
const { ggeServerMap, e4kServerMap } = require('./utils/ws/sockets');

module.exports = function (sockets) {
    const app = express();

    app.use(express.json());

    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    });

    // ─── Lista de servidores disponíveis ─────────────────────────────────────
    app.get("/servers", (req, res) => {
        const gge = Object.keys(ggeServerMap).map(zone => ({ zone, gameType: 'GGE' }));
        const e4k = Object.keys(e4kServerMap).map(zone => ({ zone, gameType: 'E4K' }));
        const all = [...gge, ...e4k].sort((a, b) => a.zone.localeCompare(b.zone));
        res.status(200).json(all);
    });

    // ─── Verificação de credenciais do bot ───────────────────────────────────
    // Body: { server: "EmpireEx_1", gameName: "NomeJogador", gamePassword: "senha" }
    app.post("/verify-bot", async (req, res) => {
        const { server, gameName, gamePassword } = req.body ?? {};

        if (!server || !gameName || !gamePassword) {
            return res.status(400).json({ error: "server, gameName e gamePassword são obrigatórios." });
        }

        try {
            const result = await verifyBot(server, gameName, gamePassword);
            const status = result.valid ? 200 : 401;
            return res.status(status).json(result);
        } catch (error) {
            console.error("Erro em /verify-bot:", error.message);
            return res.status(500).json({ valid: false, reason: "Erro interno na verificação." });
        }
    });

    app.post("/discover-server", async (req, res) => {
        const { gameName, gamePassword } = req.body ?? {};

        if (!gameName || !gamePassword) {
            return res.status(400).json({ error: "gameName e gamePassword sao obrigatorios." });
        }

        try {
            const result = await discoverBotServer(gameName, gamePassword);
            const status = result.valid ? 200 : 404;
            return res.status(status).json(result);
        } catch (error) {
            console.error("Erro em /discover-server:", error.message);
            return res.status(500).json({ valid: false, reason: "Erro interno na descoberta do servidor." });
        }
    });

    // ─── Envia comando do jogo pelo socket de um bot ─────────────────────────
    app.get("/:botId/:command/:headers", async (req, res) => {
        const { botId, command, headers } = req.params;

        if (!(botId in sockets)) {
            return res.status(404).json({ error: "Bot não encontrado ou desconectado." });
        }

        const botSocket = sockets[botId];

        if (!botSocket.connected.isSet) {
            return res.status(500).json({ error: "Bot não está conectado ao servidor do jogo." });
        }

        try {
            const messageHeaders = JSON.parse(`{${headers}}`);
            botSocket.socket.sendJsonCommand(command, messageHeaders);

            let responseHeaders = {};
            if (command in commands) {
                for (const [messageKey, responsePath] of Object.entries(commands[command])) {
                    if (messageKey in messageHeaders) {
                        setNestedValue(responseHeaders, responsePath, messageHeaders[messageKey]);
                    }
                }
            } else {
                responseHeaders = messageHeaders;
            }

            const response = await botSocket.socket.waitForJsonResponse(command, responseHeaders, 1000);
            return res.status(200).json({
                botId,
                command,
                return_code: response.payload.status,
                content: response.payload.data,
            });
        } catch (error) {
            console.error(`Erro no comando ${command} (bot ${botId}):`, error.message);
            return res.status(400).json({ error: "Comando inválido, timeout ou headers incorretos." });
        }
    });

    // ─── Status de conexão de todos os bots ─────────────────────────────────
    app.get("/status", (req, res) => {
        const status = {};
        for (const [botId, socket] of Object.entries(sockets)) {
            status[botId] = socket.connected.isSet;
        }
        res.status(200).json(status);
    });

    app.get("/", (req, res) => res.status(200).send("Empire API rodando"));

    return app;
};
