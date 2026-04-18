package com.synapse.client

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI
import com.google.gson.Gson

@Service(Service.Level.PROJECT)
class SynapseClient(private val project: Project) {
    private var ws: WebSocketClient? = null
    private val gson = Gson()

    fun connect(port: Int = 3457) {
        val basePath = project.basePath ?: return
        val uri = URI("ws://localhost:$port?ide=jetbrains&workspace=$basePath")
        ws = object : WebSocketClient(uri) {
            override fun onOpen(handshake: ServerHandshake?) {
                println("Synapse: Connected")
            }

            override fun onMessage(message: String?) {
                message?.let {
                    val resp = gson.fromJson(it, Map::class.java)
                    if (resp["type"] == "sync_complete") {
                        Messages.showInfoMessage(project, "Sync complete!", "Synapse")
                    }
                }
            }

            override fun onClose(code: Int, reason: String?, remote: Boolean) = Unit
            override fun onError(ex: Exception?) = println("WS error: ${ex?.message}")
        }
        ws?.connect()
    }

    fun sync(target: String = "all") {
        ws?.send(gson.toJson(mapOf("type" to "sync", "target" to target, "requestId" to System.currentTimeMillis())))
    }

    fun getRules() {
        ws?.send(gson.toJson(mapOf("type" to "get_rules", "requestId" to System.currentTimeMillis())))
    }

    fun disconnect() = ws?.close()
}

