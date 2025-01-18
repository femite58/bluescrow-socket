const express = require("express");
const app = express();
const http = require("http");
const https = require("https");
const httpServer = http.createServer(app);
const cors = require("cors");
const mysql = require("mysql");
const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK
const serviceAccount = require("./googleserviceaccountkey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const con = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "nodedb",
});

con.connect((err) => {
  if (err) {
    console.log(err);
  }
});

const io = require("socket.io")(httpServer, {
  cors: { origin: "*" },
});
app.use(express.json());
// app.use(cors({ origin: "*", allowedHeaders: "Content-Type" }));

const port = process.env.PORT || 3000;

let rooms = {};
const api = "api.pavypay.com";
const thePath = "/api";
const apiPort = 443;

const regIds = {};

app.post("/payment", (req, res) => {
  let data = req.body;
  io.to(data.username).emit("deposit", data.data);
  let msg = `You have successfully funded your wallet with NGN${data.data["amount"]}`;
  gcmNotif(data.username, msg, "deposit");
  res
    .writeHead(200, {
      "Content-Type": "application/json",
    })
    .end(JSON.stringify({ data: "success" }));
});

app.post("/transfer", (req, res) => {
  const options = {
    host: api,
    port: apiPort,
    path: `${thePath}/user/transfer/create`,
    headers: {
      Authorization: req.header("Authorization"),
      "Content-Type": "application/json",
    },
    method: "POST",
  };
  const hreq = https.request(options, (hres) => {
    let str = "";
    hres.on("data", (data) => {
      str += data;
    });
    hres.on("end", () => {
      try {
        let ret = JSON.parse(str).data;
        io.to(ret.receiver.username).emit("transfer", ret);
        let topTrans = ret["receiver"]["topTransaction"];
        topTrans.sort(
          (a, b) => Date.parse(b["created_at"]) - Date.parse(a["created_at"])
        );
        var depamnt = +topTrans[0]["amount"];
        msg = `${ret["sender"]["username"].replace(/./, (m) =>
          m.toUpperCase()
        )} have credited your wallet with NGN${depamnt}`;
        gcmNotif(ret.receiver.username, msg, "transfer");
        res
          .writeHead(200, {
            "Content-Type": "application/json",
          })
          .end(JSON.stringify({ data: ret.sender }));
      } catch (e) {
        console.log(e);
      }
    });
  });
  hreq.write(JSON.stringify(req.body));
  hreq.on("error", (e) => {
    console.log(e);
  });
  hreq.end();
});

app.post("/notification-delivered", (req, res) => {
  let [user, token] = req.body;
  const options = {
    host: api,
    port: apiPort,
    path: `${thePath}/user/header-notification`,
    headers: { Authorization: `Bearer ${user.token}` },
  };
  const hreq = https.request(options, (hres) => {
    let str = "";
    hres.on("data", (data) => {
      str += data;
    });
    hres.on("end", () => {
      try {
        let ret = JSON.parse(str).data;
        let disputes = ret.disputes;
        // loop over the disputes to emit messages to all in its room
        //   console.log(disputes);
        if (disputes) {
          for (let disp of disputes) {
            io.to(`dispute${disp.escrow.id}`).emit("messages", disp);
          }
        }
        res.writeHead(200).end();
      } catch (e) {
        console.log(e);
      }
    });
  });
  hreq.on("error", (e) => {
    console.log(e);
  });
  hreq.end();
});

app.post("/general-notification", (req, res) => {
  let { users, notif } = req.body;
  generalNotif(users, notif);
  res
    .writeHead(200, {
      "Content-Type": "application/json",
    })
    .end(JSON.stringify({ data: "success" }));
});

// app.get("/update-regId", (req, res) => {
//   regIds = regIds.filter((r) => r != req.query["regId"]);
//   regIds.push(req.query["regId"]);
//   res.send();
// });

const generalNotif = (users, notif) => {
  let sql;
  if (users.length) {
    sql = `SELECT * FROM users WHERE username IN (${users
      .map((u) => `'${u}'`)
      .join(",")})`;
  } else {
    sql = `SELECT * FROM users`;
  }
  con.query(sql, async (err, res) => {
    if (!res.length) return;
    let deviceIds = res.map((u) => u.device_id);
    let data = {};
    data["general"] = JSON.stringify(notif);
    const payload = {
      data: {
        ...data, // Add your custom data here
      },
      android: {
        priority: "high", // Set priority for Android devices
      },
    };

    try {
      const response = await admin.messaging().sendMulticast({
        tokens: deviceIds, // Array of registration tokens
        ...payload,
      });

      console.log("Notifications sent:", response.successCount);
      console.log("Failures:", response.failureCount);
      console.log("Details:", response.responses);
    } catch (error) {
      console.error("Error sending notifications:", error);
    }
  });
};

const gcmNotif = (user, notif, key = "notif") => {
  let sql = `SELECT * FROM users WHERE username = '${user}'`;
  con.query(sql, (err, sres) => {
    if (!sres.length) return;
    let deviceId = sres[0].device_id;
    const sendNotif = async (data) => {
      const payload = {
        data: {
          ...data, // Add your custom data here
        },
        android: {
          priority: "high", // Set priority for Android devices
        },
        token: deviceId,
      };

      try {
        const response = await admin.messaging().send(payload);
        console.log("Notification sent successfully:", response);
        let usql = `UPDATE users SET sent_notification = '${JSON.stringify(
          notif
        )}' WHERE username = '${user}'`;
        con.query(usql, (err, ures) => {
          console.log(`updated sent notification for ${user}`);
        });
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    };
    if (deviceId) {
      if (key == "notif") {
        for (let n of notif) {
          let data = {};
          data[key] = JSON.stringify(n);
          sendNotif(data);
        }
      } else {
        let data = {};
        data[key] = JSON.stringify(notif);
        sendNotif(data);
      }
    }
  });
};

io.on("connection", (socket) => {
  console.log("a user connected");
  let prevRmId;

  const joinRoom = (rmid, user, socketId) => {
    socket.leave(prevRmId);
    socket.join(rmid);
    let exist = rooms[rmid]
      ? rooms[rmid].find((each) => each == `${user},${socketId}`)
      : null;
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
    // if (message.receiver_one) {
    //   if (!userInRoom(`dispute${message.escrow_id}`, message.receiver_one)) {
    //     message.receiver_one_notification = 1;
    //     message.receiver_one_seen = 0;
    //   } else {
    //     message.receiver_one_notification = 0;
    //     message.receiver_one_seen = 1;
    //   }
    //   if (!userInRoom(`dispute${message.escrow_id}`, message.receiver_two)) {
    //     message.receiver_two_notification = 1;
    //     message.receiver_two_seen = 0;
    //   } else {
    //     message.receiver_two_notification = 0;
    //     message.receiver_two_seen = 1;
    //   }
    //   if (socket.adapter.rooms.has(message.receiver_one)) {
    //     message.receiver_one_delivered = 1;
    //   } else {
    //     message.receiver_one_delivered = 0;
    //   }
    //   if (socket.adapter.rooms.has(message.receiver_two)) {
    //     message.receiver_two_delivered = 1;
    //   } else {
    //     message.receiver_two_delivered = 0;
    //   }
    // } else {
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
    // }

    const options = {
      host: api,
      port: apiPort,
      path: `${thePath}/user/disputes/create`,
      headers: {
        Authorization: `Bearer ${user.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          if (message.notification) {
            io.to(message.receiver).emit(
              "notifications",
              ret.receiver_notification
            );
            gcmNotif(message.receiver, ret.receiver_notification);
          }
          if (message.admin_notification) {
            io.to("admin").emit("notifications", ret.admin_notification);
            gcmNotif("admin", ret.admin_notification);
          }
          io.to(`dispute${message.escrow_id}`).emit("sentMsg", {
            message: ret.message,
            escrow: ret.escrow,
          });
          io.to(`escSingle${message.escrow_id}`).emit("escrowSingle", {
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

  socket.on("notifications", (user, token) => {
    socket.join(user.username);
    if (token) {
      let sql = `UPDATE users SET device_id = '${token}' WHERE username = '${user.username}'`;
      con.query(sql, (serr, res) => {
        if (serr) {
          console.log(serr);
          return;
        }
        if (!res.affectedRows) {
          let isql = `INSERT INTO users (username, device_id) VALUES ('${user.username}', '${token}')`;
          con.query(isql, (ierr, ires) => {
            if (ierr) {
              console.log(ierr);
              return;
            }
            console.log(`inserted ${user.username}`);
          });
          return;
        }
        console.log(`updated ${user.username}`);
      });
      regIds[user.username] = token;
    }
    const options = {
      host: api,
      port: apiPort,
      path: `${thePath}/user/header-notification`,
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
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
          gcmNotif(user.username, ret.notification);
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
    // regIds[user.username] = null;
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
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          socket.emit("escrowSingle", ret);
          io.to(user.username).emit("notifications", ret.notifications);
          gcmNotif(user.username, ret.notifications);
        } catch (e) {
          console.log(e);
        }
      });
    });
    req.on("error", (e) => {
      console.log(e);
      socket.emit("escrowSingle", JSON.stringify(e));
    });
    req.end();
  });

  socket.on("createEscrow", (escrow, user) => {
    const options = {
      host: api,
      port: apiPort,
      path: `${thePath}/user/escrow/create`,
      headers: { Authorization: `Bearer ${user.token}` },
      method: "POST",
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          socket.emit("escrow", ret.escrow);
          io.to(ret.escrow.receiver).emit("notifications", ret.notification);
          gcmNotif(ret.escrow.receiver, ret.notification);
        } catch (e) {
          console.log(e);
        }
      });
    });
    req.write(escrow);
    req.on("error", (e) => {
      console.log(e);
      socket.emit("escrow", e.error);
    });
    req.end();
  });

  socket.on("moreTime", (mtimeF, user) => {
    const options = {
      host: api,
      port: apiPort,
      path: `${thePath}/user/escrow/add-time`,
      headers: { Authorization: `Bearer ${user.token}` },
      method: "POST",
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          io.to(`escSingle${ret.escrow.id}`).emit("escrowSingle", ret);
          io.to(ret.escrow.buyer).emit("notifications", ret.notification);
          gcmNotif(ret.escrow.buyer, ret.notification);
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
      headers: { Authorization: `Bearer ${user.token}` },
      method: "PUT",
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          socket.emit("escDeliveryResp", { ...ret });
          io.to(`escSingle${ret.escrow.id}`).emit("escrowSingle", ret);
          if (user.username == ret.escrow.buyer) {
            io.to(ret.escrow.seller).emit("notifications", ret.notification);
            gcmNotif(ret.escrow.seller, ret.notification);
          } else {
            io.to(ret.escrow.buyer).emit("notifications", ret.notification);
            gcmNotif(ret.escrow.buyer, ret.notification);
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
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          // socket.emit("cancelTimeRes", ret.escrow);
          io.to(`escSingle${ret.escrow.id}`).emit("escrowSingle", ret);
          io.to(ret.escrow.buyer).emit("notifications", ret.notification);
          gcmNotif(ret.escrow.buyer, ret.notification);
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

  socket.on("acceptTime", (id, user, role) => {
    const options = {
      host: api,
      port: apiPort,
      path: `${thePath}/user/escrow/approve-duration/${id}/${role}`,
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          // socket.emit("acceptTimeRes", ret.escrow);
          io.to(`escSingle${ret.escrow.id}`).emit("escrowSingle", ret);
          io.to(ret.escrow.seller).emit("notifications", ret.notification);
          gcmNotif(ret.escrow.seller, ret.notification);
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
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let raw = JSON.parse(str);
          let ret = raw.data || {
            error:
              "This transaction activation fails due to an insufficient fund on your buyer's wallet",
          };
          socket.emit("escActionRes", ret);
          if (!raw.data) {
            generalNotif([escrow.initiator], {
              title: "Escrow Acceptance Error",
              content: `Your escrow transaction with the escrow id ${escrow.ref_no} cannot be accepted by your seller ${escrow.seller} at the moment due to insufficient fund in your wallet. Please fund your wallet to enable successful acceptance by your seller.`,
            });
            return;
          }
          io.to(`escSingle${ret.escrow.id}`).emit("escrowSingle", ret);
          if (role != "cancelled") {
            io.to(ret.escrow.initiator).emit("notifications", ret.notification);
            gcmNotif(ret.escrow.initiator, ret.notification);
          } else {
            io.to(ret.escrow.receiver).emit("notifications", ret.notification);
            gcmNotif(ret.escrow.receiver, ret.notification);
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
      path: `${thePath}/user/disputes/single/${dispId}/20/1`,
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
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
          io.to(user.username).emit("notifications", ret.notification);
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

  socket.on("typingTrigger", (dispId, msg, username) => {
    io.to(`dispute${dispId}`).emit("isTyping", { user: username, typing: msg });
  });

  socket.on("closeDispute", (dispId, user) => {
    const options = {
      host: api,
      port: apiPort,
      path: `${thePath}/user/disputes/resolve/${dispId}`,
      headers: { Authorization: `Bearer ${user.token}` },
    };
    const req = https.request(options, (res) => {
      let str = "";
      res.on("data", (data) => {
        str += data;
      });
      res.on("end", () => {
        try {
          let ret = JSON.parse(str).data;
          io.to(`dispute${dispId}`).emit("closeDispResp", "closed");
          io.to(`dispute${dispId}`).emit("messages", ret);
          if (user.username == ret.escrow.buyer) {
            io.to(ret.escrow.seller).emit(
              "notifications",
              ret.receiver_notification
            );
            gcmNotif(ret.escrow.seller, ret.receiver_notification);
          } else {
            io.to(ret.escrow.buyer).emit(
              "notifications",
              ret.receiver_notification
            );
            gcmNotif(ret.escrow.buyer, ret.receiver_notification);
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
    if (user) {
      leaveRoom(`dispute${dispId}`, user.username, socket.id);
    } else {
      leaveAllRooms(socket.id);
    }
  });

  socket.on("disconnect", () => {
    leaveAllRooms(socket.id);
  });
});
httpServer.listen(port, () => console.log(`listening on port ${port}`));
