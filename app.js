const express = require('express');
const commands = require('./data/commands.json');
const { setNestedValue } = require('./utils/nestedHeaders');
const { verifyBot, discoverBotServer } = require('./utils/verifyBot');
const { ggeServerMap, e4kServerMap } = require('./utils/ws/sockets');
const { getUserFromAccessToken, setBotPower } = require('./utils/supabaseService');

module.exports = function (sockets) {
    const app = express();

    app.use(express.json());

    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    });

    async function getAuthenticatedUser(req) {
        const authHeader = req.get("authorization") ?? "";
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        return getUserFromAccessToken(match?.[1]);
    }

    async function handleSetBotStatus(req, res, input) {
        const user = await getAuthenticatedUser(req);
        if (!user) {
            return res.status(401).json({ error: "Sessao invalida ou expirada." });
        }

        const botId = String(input.botId ?? "");
        const isOn = input.isOn;

        if (!botId || typeof isOn !== "boolean") {
            return res.status(400).json({ error: "botId e isOn sao obrigatorios." });
        }

        try {
            const bot = await setBotPower(botId, isOn, user.id);
            return res.status(200).json({
                botId: bot.id,
                isOn: bot.is_on,
                connected: sockets[bot.id]?.connected?.isSet ?? false,
            });
        } catch (error) {
            console.error("Erro ao alterar status do bot:", error.message);
            return res.status(404).json({ error: "Bot nao encontrado para este usuario." });
        }
    }

    async function handleRawCommand(res, botId, input) {
        const { command, args = [], waitForCommand, timeout = 5000 } = input ?? {};

        if (!(botId in sockets)) {
            return res.status(404).json({ error: "Bot nao encontrado ou desconectado." });
        }

        const botSocket = sockets[botId];

        if (!botSocket.connected.isSet) {
            return res.status(500).json({ error: "Bot nao esta conectado ao servidor do jogo." });
        }

        if (!command || typeof command !== "string" || !Array.isArray(args)) {
            return res.status(400).json({ error: "command e args[] sao obrigatorios." });
        }

        try {
            botSocket.socket.sendRawCommand(command, args.map(String));

            if (!waitForCommand) {
                return res.status(200).json({ botId, command, args, sent: true });
            }

            const response = await botSocket.socket.waitForJsonResponse(
                String(waitForCommand),
                true,
                Number(timeout) || 5000
            );

            return res.status(200).json({
                botId,
                command,
                args,
                sent: true,
                return_code: response.payload.status,
                content: response.payload.data,
            });
        } catch (error) {
            console.error(`Erro no raw-command ${command} (bot ${botId}):`, error.message);
            return res.status(400).json({ error: "Comando raw invalido, timeout ou resposta incorreta." });
        }
    }

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
        const { gameName, gamePassword, preferredServer } = req.body ?? {};

        if (!gameName || !gamePassword) {
            return res.status(400).json({ error: "gameName e gamePassword sao obrigatorios." });
        }

        try {
            const result = await discoverBotServer(gameName, gamePassword, preferredServer);
            const status = result.valid ? 200 : 404;
            return res.status(status).json(result);
        } catch (error) {
            console.error("Erro em /discover-server:", error.message);
            return res.status(500).json({ valid: false, reason: "Erro interno na descoberta do servidor." });
        }
    });

    app.post("/bots/:botId/status", async (req, res) => {
        return handleSetBotStatus(req, res, {
            botId: req.params.botId,
            isOn: req.body?.isOn,
        });
    });

    app.post("/bots/:botId/raw-command", async (req, res) => {
        const { botId } = req.params;
        return handleRawCommand(res, botId, req.body);
    });

    app.post("/bots/:botId/alerts/send-soldiers", async (req, res) => {
        const { castleId, mode = 1, wave = 0, amount = 12 } = req.body ?? {};

        if (!castleId) {
            return res.status(400).json({ error: "castleId e obrigatorio." });
        }

        return handleRawCommand(res, req.params.botId, {
            command: "sendSoldiers",
            args: [castleId, mode, wave, amount],
        });
    });

    app.get("/setBotStatus.php", async (req, res) => {
        return handleSetBotStatus(req, res, {
            botId: req.query.bot,
            isOn: String(req.query.status) === "1",
        });
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
