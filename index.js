const app = require("express")();
const http = require("http");
const https = require("https");
const httpServer = http.createServer(app);
const io = require("socket.io")(httpServer, {
    cors: { origin: "*" },
});

const port = process.env.PORT || 3000;

let rooms = {};
const api = "api.bluescrow.com";
const thePath = "/laravel";
const apiPort = 443;
io.on("connection", (socket) => {
    console.log("a user connected");
    let prevRmId;

    const joinRoom = (rmid, user, socketId) => {
        socket.leave(prevRmId);
        socket.join(rmid);
        console.log(rooms);
        let exist = rooms[rmid] ?
            rooms[rmid].find((each) => each == `${user},${socketId}`) :
            null;
        if (!exist) {
            if (rooms[rmid]) {
                rooms[rmid].push(`${user},${socketId}`);
            } else {
                rooms[rmid] = [`${user},${socketId}`];
            }
        }
        prevRmId = rmid;
    };

    const leaveRoom = (rmid, user, socketId) => {
        socket.leave(rmid);
        rooms[rmid] = rooms[rmid].filter((each) => each.split(",")[1] != socketId);
    };

    const leaveAllRooms = (socketId) => {
        for (let key in rooms) {
            rooms[key] = rooms[key].filter((each) => each.split(",")[1] != socketId);
        }
    };

    const userInRoom = (rmid, user) => {
        return rooms[rmid].find((each) => each.split(",")[0] == user);
    };

    socket.on("message", (message, user) => {
        if (message.receiver_one) {
            if (!userInRoom(`dispute${message.escrow_id}`, message.receiver_one)) {
                message.receiver_one_notification = 1;
                message.receiver_one_seen = 0;
            } else {
                message.receiver_one_notification = 0;
                message.receiver_one_seen = 1;
            }
            if (!userInRoom(`dispute${message.escrow_id}`, message.receiver_two)) {
                message.receiver_two_notification = 1;
                message.receiver_two_seen = 0;
            } else {
                message.receiver_two_notification = 0;
                message.receiver_two_seen = 1;
            }
            if (socket.adapter.rooms.has(message.receiver_one)) {
                message.receiver_one_delivered = 1;
            } else {
                message.receiver_one_delivered = 0;
            }
            if (socket.adapter.rooms.has(message.receiver_two)) {
                message.receiver_two_delivered = 1;
            } else {
                message.receiver_two_delivered = 0;
            }
        } else {
            if (!userInRoom(`dispute${message.escrow_id}`, message.receiver)) {
                message.notification = 1;
                message.receiver_seen = 0;
            } else {
                message.notification = 0;
                message.receiver_seen = 1;
            }
            if (!userInRoom(`dispute${message.escrow_id}`, "admin")) {
                message.admin_notification = 1;
            } else {
                message.admin_notification = 0;
            }
            if (socket.adapter.rooms.has(message.receiver)) {
                message.receiver_delivered = 1;
            } else {
                message.receiver_delivered = 0;
            }
            if (socket.adapter.rooms.has("admin")) {
                message.admin_delivered = 1;
            } else {
                message.admin_delivered = 0;
            }
        }

        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/disputes/create`,
            headers: { "Api-Token": user.token, "Content-Type": "application/json" },
            method: "POST",
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    if (message.notification) {
                        io.to(message.receiver).emit(
                            "notifications",
                            ret.receiver_notification
                        );
                    }
                    if (message.admin_notification) {
                        io.to("admin").emit("notifications", ret.admin_notification);
                    }
                    io.to(`dispute${message.escrow_id}`).emit("messages", {
                        chats: ret.chats,
                        escrow: ret.escrow,
                    });
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.write(JSON.stringify(message));
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("notifications", (user) => {
        socket.join(user.username);
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/header-notification`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    let disputes = ret.disputes;
                    // loop over the disputes to emit messages to all in its room
                    if (disputes) {
                        for (let disp of disputes) {
                            io.to(`dispute${disp.escrow.id}`).emit("messages", disp);
                        }
                    }
                    socket.emit("notifications", ret.notification);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("leaveNotif", (user) => {
        socket.leave(user.username);
    });

    let prevEscId;

    socket.on("leaveEscSingle", (escId) => {
        socket.leave(`escSingle${escId}`);
    });

    socket.on("escrowSingle", (user, escId) => {
        socket.leave(prevEscId);
        socket.join(`escSingle${escId}`);
        prevEscId = `escSingle${escId}`;
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/single/${escId}`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    socket.emit("escrowSingle", ret);
                    io.to(user.username).emit("notifications", ret.notifications);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
            socket.emit('escrowSingle', JSON.stringify(e));
        });
        req.end();
    });

    socket.on("createEscrow", (escrow, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/create`,
            headers: { "Api-Token": user.token },
            method: "POST",
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    socket.emit("escrow", ret.escrow);
                    io.to(ret.escrow.receiver).emit("notifications", ret.notification);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.write(escrow);
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("moreTime", (mtimeF, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/add-time`,
            headers: { "Api-Token": user.token },
            method: "POST",
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    io.to(`escSingle${ret.escrow.id}`).emit('escrowSingle', ret);
                    io.to(ret.escrow.buyer).emit("notifications", ret.notification);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.write(mtimeF);
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("confirmDelivery", (pdata, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/deliver`,
            headers: { "Api-Token": user.token },
            method: "PUT",
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    socket.emit("escDeliveryResp", {...ret });
                    io.to(`escSingle${ret.escrow.id}`).emit('escrowSingle', ret);
                    if (user.username == ret.escrow.buyer) {
                        io.to(ret.escrow.seller).emit("notifications", ret.notification);
                    } else {
                        io.to(ret.escrow.buyer).emit("notifications", ret.notification);
                    }
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.write(pdata);
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("cancelTime", (id, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/cancel-time/${id}`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    // socket.emit("cancelTimeRes", ret.escrow);
                    io.to(`escSingle${ret.escrow.id}`).emit('escrowSingle', ret);
                    io.to(ret.escrow.buyer).emit("notifications", ret.notification);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("acceptTime", (id, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/approve-duration/${id}`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    // socket.emit("acceptTimeRes", ret.escrow);
                    io.to(`escSingle${ret.escrow.id}`).emit('escrowSingle', ret);
                    io.to(ret.escrow.seller).emit("notifications", ret.notification);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("escAction", (escrow, role, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/escrow/action/${escrow.id}/${role}`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    socket.emit("escActionRes", ret);
                    io.to(`escSingle${ret.escrow.id}`).emit('escrowSingle', ret);
                    if (role != "cancelled") {
                        io.to(ret.escrow.initiator).emit("notifications", ret.notification);
                    } else {
                        io.to(ret.escrow.receiver).emit("notifications", ret.notification);
                    }
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("messages", (dispId, user) => {
        joinRoom(`dispute${dispId}`, user.username, socket.id);
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/disputes/single/${dispId}`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    if (!ret.chats.length) {
                        if (
                            ret.escrow.status == "Completed" ||
                            (ret.escrow.status == "Active" && !+ret.escrow.seller_delivered)
                        ) {
                            socket.emit("messages", "Unable to create");
                        } else {
                            io.to(`dispute${dispId}`).emit("messages", ret);
                        }
                    } else {
                        io.to(`dispute${dispId}`).emit("messages", ret);
                    }
                    io.to(user.username).emit("notifications", ret.notifcation);
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
            socket.emit("messages", "Unauthorized");
        });
        req.end();
    });

    socket.on("closeDispute", (dispId, user) => {
        const options = {
            host: api,
            port: apiPort,
            path: `${thePath}/user/disputes/resolve/${dispId}`,
            headers: { "Api-Token": user.token },
        };
        const req = https.request(options, (res) => {
            let str = "";
            res.on("data", (data) => {
                str += data;
            });
            res.on("end", () => {
                console.log(str);
                try {
                    let ret = JSON.parse(str).data;
                    socket.emit("closeDispResp", "closed");
                    io.to(`dispute${dispId}`).emit("messages", ret);
                    if (user.username == ret.escrow.buyer) {
                        io.to(ret.escrow.seller).emit(
                            "notifications",
                            ret.receiver_notification
                        );
                    } else {
                        io.to(ret.escrow.buyer).emit(
                            "notifications",
                            ret.receiver_notification
                        );
                    }
                } catch (e) {
                    console.log(e);
                }
            });
        });
        req.on("error", (e) => {
            console.log(e);
        });
        req.end();
    });

    socket.on("leaveroom", (dispId, user) => {
        leaveRoom(`dispute${dispId}`, user.username, socket.id);
    });

    socket.on("disconnect", () => {
        leaveAllRooms(socket.id);
    });
});
httpServer.listen(port, () => console.log(`listening on port ${port}`));