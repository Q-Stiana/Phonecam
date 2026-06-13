"""
WebSocket DAT Callbacks

me - this DAT

dat - the WebSocket DAT
"""

def onConnect(dat: websocketDAT):
	"""
	Called when a WebSocket connection is established.
	"""
	return

def onDisconnect(dat: websocketDAT):
	"""
	Called when a WebSocket connection is disconnected.
	"""
	return

def onReceiveText(dat: websocketDAT, rowIndex: int, message: str):
	"""
	Called when a text frame message is received. Only text frame messages 
	will be handled in this function.
	
	Args:
		dat: The DAT that received a message
		rowIndex: The row number the message was placed into
		message: A unicode representation of the text
	"""
	return


def onReceiveBinary(dat: websocketDAT, contents: bytes):
	"""
	Called when a binary frame message is received. Only binary frame 
	messages will be handled in this function.
	
	Args:
		dat: The DAT that received a message
		contents: A byte array of the message contents
	"""
	return

def onReceivePing(dat: websocketDAT, contents: bytes):
	"""
	Called when a ping message is received. Only ping messages will be 
	handled in this function.
	
	Args:
		dat: The DAT that received a message
		contents: A byte array of the message contents
	"""
	dat.sendPong(contents) # send a reply with same message
	return

def onReceivePong(dat: websocketDAT, contents: bytes):
	"""
	Called when a pong message is received. Only pong messages will be 
	handled in this function.
	
	Args:
		dat: The DAT that received a message
		contents: A byte array of the message content
	"""
	return

def onMonitorMessage(dat: websocketDAT, message: str):
	"""
	Called to monitor the websocket status messages.
	
	Args:
		dat: The DAT that received a message
		message: A unicode representation of the message
	"""
	return
