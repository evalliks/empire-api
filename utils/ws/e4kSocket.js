
const { BaseSocket } = require('./baseSocket');
const { Event } = require('../event');
const { setBotConnected, syncBotGameData } = require('../supabaseService');

class E4kSocket {
    /**
     * @param {string} url           - URL do WebSocket do servidor (ws://...)
     * @param {string} serverHeader  - Zona do servidor E4K
     * @param {string} username      - Nome de jogador in-game
     * @param {string} password      - Senha da conta do jogo
     * @param {string|null} botId    - ID do documento do bot no Firestore
     */
    constructor(url, serverHeader, username, password, botId = null) {
        this.url = url;
        this.serverHeader = serverHeader;
        this.username = username;
        this.password = password;
        this.botId = botId;
        this.connected = new Event();
        this.reconnect = true;
        this.socket = null;
    }

    async connect() {
        try {
            this.socket = new BaseSocket(this.url, this.serverHeader);

            this.socket.onError = (error) => {
                console.log(`### erro no socket ${this.serverHeader} (bot: ${this.botId}) ###`);
                console.log(error.message);
                if (["ENOTFOUND", "ETIMEDOUT"].includes(error.code)) {
                    this.disconnect(false);
                } else {
                    this.disconnect(true);
                }
            };

            this.socket.onClose = (code, reason) => {
                console.log(`### socket ${this.serverHeader} (bot: ${this.botId}) fechado${this.reconnect ? "" : " permanentemente"} ###`);
                if (this.reconnect) {
                    this.disconnect(true);
                    setTimeout(() => this.connect(), 10 * 1000);
                } else {
                    this.disconnect(false);
                }
            };

            if (!(await this.socket.opened.wait(60000))) throw new Error("Socket não conectou");
            console.log(`### socket ${this.serverHeader} (bot: ${this.botId}) conectado ###`);

            this.socket.sendXmlMessage("sys", "verChk", "0", "<ver v='166' />");
            await this.socket.waitForXmlResponse("sys", "apiOK", "0");
            const responseAsync = this.socket.waitForJsonResponse("nfo");
            this.socket.sendXmlMessage("sys", "login", "0", `<login z='${this.serverHeader}'><nick><![CDATA[]]></nick><pword><![CDATA[1065004%fr%0]]></pword></login>`);
            const nfoResponse = await responseAsync;
            this.socket.raiseForStatus(nfoResponse);
            this.socket.sendXmlMessage("sys", "autoJoin", "-1", "");
            await this.socket.waitForXmlResponse("sys", "joinOK", "1");
            this.socket.sendXmlMessage("sys", "roundTrip", "1", "");
            await this.socket.waitForXmlResponse("sys", "roundTripRes", "1");
            await this.ping();

            this.socket.sendJsonCommand("core_lga", {
                NM: this.username, PW: this.password,
                L: "fr", AID: "1674256959939529708",
                DID: "5", PLFID: "3",
                ADID: "null", AFUID: "appsFlyerUID", IDFV: "null"
            });
            const lgaResponse = await this.socket.waitForJsonResponse("core_lga");

            if (lgaResponse.payload.status === 10005) {
                this.connected.set();
                if (this.botId) await setBotConnected(this.botId, true);
                await this.checkConnection();
            } else if (lgaResponse.payload.status === 10010) {
                // Conta não existe — registra via socket e tenta novamente
                this.socket.sendJsonCommand("core_reg", {
                    PN: this.username, PW: this.password,
                    MAIL: `${this.username}@mail.com`,
                    LANG: "fr", AID: "1674256959939529708",
                    DID: "5", PLFID: "3",
                    ADID: "null", AFUID: "appsFlyerUID", IDFV: "null", REF: ""
                });
                const regResponse = await this.socket.waitForJsonResponse("core_reg");
                if (regResponse.payload.status === 10005) {
                    this.socket.sendJsonCommand("core_lga", {
                        NM: this.username, PW: this.password,
                        L: "fr", AID: "1674256959939529708",
                        DID: "5", PLFID: "3",
                        ADID: "null", AFUID: "appsFlyerUID", IDFV: "null"
                    });
                    const lgaResponse2 = await this.socket.waitForJsonResponse("core_lga");
                    if (lgaResponse2.payload.status === 10005) {
                        this.connected.set();
                        if (this.botId) await setBotConnected(this.botId, true);
                        await this.checkConnection();
                    } else {
                        this.disconnect(false);
                    }
                } else {
                    this.disconnect(false);
                }
            } else {
                this.disconnect(false);
            }
        } catch (error) {
            console.log(`### erro ao conectar socket ${this.serverHeader} (bot: ${this.botId}) ###`);
            console.log(error.message);
            if (this.botId) await setBotConnected(this.botId, false);
            this.disconnect(false);
        }
    }

    disconnect(reconnect = true) {
        this.connected.clear();
        this.reconnect = reconnect;
        if (this.socket) this.socket.close();
        if (!reconnect) this.socket = null;
    }

    async restart() {
        this.disconnect(false);
        this.reconnect = true;
        await this.connect();
    }

    async ping() {
        if (!this.connected.isSet) return;
        this.socket.sendRawCommand("pin", ["<RoundHouseKick>"]);
        setTimeout(() => this.ping(), 60 * 1000);
    }

    async checkConnection() {
        if (!this.connected.isSet) return;
        try {
            this.socket.sendJsonCommand("gpi", {});
            const response = await this.socket.waitForJsonResponse("gpi");

            // Sincroniza dados do jogo com o Firestore
            if (this.botId && response.payload.data) {
                await syncBotGameData(this.botId, response.payload.data);
            }

            setTimeout(() => this.checkConnection(), 15 * 60 * 1000);
        } catch (error) {
            if (this.botId) await setBotConnected(this.botId, false);
            this.disconnect(true);
        }
    }
}

module.exports = { E4kSocket };
