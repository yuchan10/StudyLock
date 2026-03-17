const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let waitingUsers = [];
let groups = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinMatch', (userData) => {
        userData.id = socket.id;
        userData.status = 'idle';
        userData.studySec = 0;
        waitingUsers.push(userData);

        // 3명 이상 모이면 실시간 그룹 결성
        if (waitingUsers.length >= 3) {
            const groupId = 'group_' + Date.now();
            const members = waitingUsers.splice(0, 3);
            
            groups[groupId] = {
                id: groupId,
                name: 'FOCUS GROUP ' + Math.floor(Math.random() * 900 + 100),
                members: members,
                adminId: members[Math.floor(Math.random() * members.length)].id
            };

            members.forEach(m => {
                io.to(m.id).emit('matchComplete', {
                    groupId: groupId,
                    groupData: groups[groupId],
                    myId: m.id
                });
            });
        }
    });

    socket.on('startStudy', (groupId) => {
        if (groups[groupId]) {
            const member = groups[groupId].members.find(m => m.id === socket.id);
            if (member) member.status = 'studying';
            io.to(groupId).emit('groupUpdate', groups[groupId]);
        }
    });

    socket.on('stopStudy', ({ groupId, sessionSec }) => {
        if (groups[groupId]) {
            const member = groups[groupId].members.find(m => m.id === socket.id);
            if (member) {
                member.status = 'idle';
                member.studySec += sessionSec;
            }
            io.to(groupId).emit('groupUpdate', groups[groupId]);
        }
    });

    socket.on('disconnect', () => {
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
    });
});

server.listen(3000, () => {
    console.log(`Server running on http://localhost:3000`);
});