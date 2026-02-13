// 后端房间状态管理接口模拟

/**
 * 房间状态管理器
 * 负责接收前端上报的状态，并广播给房间内其他成员
 */
class RoomManager {
    constructor() {
        this.rooms = new Map(); // 存储房间状态: roomName -> { authoritativeState, members }
    }

    // 处理前端上报的状态
    handleReport(report) {
        const { roomName, tempUser, videoState } = report;
        
        if (!this.rooms.has(roomName)) {
            this.rooms.set(roomName, {
                authoritativeState: null,
                members: new Set()
            });
        }

        const room = this.rooms.get(roomName);
        room.members.add(tempUser);

        // 简单逻辑：如果是房主或者第一个人，则作为权威状态
        // 实际逻辑中可能有更复杂的权限控制
        if (!room.authoritativeState || this.isHost(roomName, tempUser)) {
            room.authoritativeState = videoState;
            this.broadcastState(roomName, videoState);
        }
    }

    // 广播状态给房间内所有成员
    broadcastState(roomName, state) {
        // 实际通过 MQTT 发布消息
        // mqttClient.publish(`room/${roomName}/broadcast`, JSON.stringify(state));
        console.log(`[Backend] Broadcasting to room ${roomName}:`, state);
    }

    isHost(roomName, user) {
        // 模拟判断房主逻辑
        return true; 
    }
}

// 导出以便测试或后续集成
if (typeof module !== 'undefined') {
    module.exports = RoomManager;
}
