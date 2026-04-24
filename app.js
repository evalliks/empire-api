const express = require('express');
const commands = require('./data/commands.json');
const { setNestedValue } = require('./utils/nestedHeaders');
const { verifyBot, discoverBotServer } = require('./utils/verifyBot');
const { ggeServerMap, e4kServerMap } = require('./utils/ws/sockets');
const { getUserFromAccessToken, setBotPower } = require('./utils/supabaseService');

module.exports = function (sockets) {
    const app = express();
    const recaptchaSecretKey = process.env.RECAPTCHA_SECRET_KEY;

    app.use(express.json());

    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    });

    async function validateRecaptchaToken(token) {
        if (!recaptchaSecretKey) {
            throw new Error("RECAPTCHA_SECRET_KEY nao configurada.");
        }

        if (!token) {
            return { valid: false, reason: "Resolva o reCAPTCHA antes de continuar." };
        }

        const params = new URLSearchParams();
        params.set("secret", recaptchaSecretKey);
        params.set("response", token);

        const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
        });

        const data = await response.json();
        if (!data.success) {
            return { valid: false, reason: "Falha na validacao do reCAPTCHA." };
        }

        return { valid: true };
    }

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
        const { server, gameName, gamePassword, recaptchaToken } = req.body ?? {};

        if (!server || !gameName || !gamePassword) {
            return res.status(400).json({ error: "server, gameName e gamePassword são obrigatórios." });
        }

        try {
            const recaptcha = await validateRecaptchaToken(recaptchaToken);
            if (!recaptcha.valid) {
                return res.status(400).json({ valid: false, reason: recaptcha.reason });
            }

            const result = await verifyBot(server, gameName, gamePassword);
            const status = result.valid ? 200 : 401;
            return res.status(status).json(result);
        } catch (error) {
            console.error("Erro em /verify-bot:", error.message);
            return res.status(500).json({ valid: false, reason: "Erro interno na verificação." });
        }
    });

    app.post("/discover-server", async (req, res) => {
        const { gameName, gamePassword, recaptchaToken, preferredServer } = req.body ?? {};

        if (!gameName || !gamePassword) {
            return res.status(400).json({ error: "gameName e gamePassword sao obrigatorios." });
        }

        try {
            const recaptcha = await validateRecaptchaToken(recaptchaToken);
            if (!recaptcha.valid) {
                return res.status(400).json({ valid: false, reason: recaptcha.reason });
            }

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
