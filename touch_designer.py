"""
WebSocket DAT Callbacks

me - this DAT

dat - the WebSocket DAT
"""

import json


PEOPLE_DAT = 'phonecam_people'
INFO_DAT = 'phonecam_info'
ID1_COLOR_DAT = 'phonecam_id1_color'
ID1_TRACK_ID = 'ID1'

COLOR_VALUES = {
	'Black': (0.08, 0.08, 0.08),
	'White': (0.93, 0.93, 0.93),
	'Red': (1.0, 0.0, 0.0),
	'Orange': (1.0, 0.48, 0.0),
	'Yellow': (1.0, 0.9, 0.0),
	'Green': (0.0, 0.75, 0.18),
	'Cyan': (0.0, 0.85, 1.0),
	'Blue': (0.05, 0.22, 1.0),
	'Purple': (0.45, 0.12, 0.95),
	'Magenta': (1.0, 0.0, 0.75),
	'Unknown': (1.0, 1.0, 1.0),
}


def _clear_and_write_table(table, headers, rows):
	table.clear()
	table.appendRow(headers)
	for row in rows:
		table.appendRow(row)


def _format_number(value, digits=6):
	try:
		return round(float(value), digits)
	except (TypeError, ValueError):
		return 0


def _rgb_to_hsv(r, g, b):
	max_v = max(r, g, b)
	min_v = min(r, g, b)
	delta = max_v - min_v
	hue = 0
	if delta:
		if max_v == r:
			hue = ((g - b) / delta) % 6
		elif max_v == g:
			hue = ((b - r) / delta) + 2
		else:
			hue = ((r - g) / delta) + 4
		hue /= 6
	saturation = 0 if max_v == 0 else delta / max_v
	return hue, saturation, max_v


def _write_id1_color(people, timestamp):
	target = None
	for person in people:
		if str(person.get('id', '')) == ID1_TRACK_ID:
			target = person
			break

	color_name = target.get('color', 'Unknown') if target else 'Unknown'
	r, g, b = COLOR_VALUES.get(color_name, COLOR_VALUES['Unknown'])
	hue, saturation, value = _rgb_to_hsv(r, g, b)
	dwell = target.get('dwell', 0) if target else 0
	person_timestamp = target.get('timestamp', timestamp) if target else timestamp

	color_dat = op(ID1_COLOR_DAT)
	if color_dat is not None:
		_clear_and_write_table(
			color_dat,
			['key', 'value'],
			[
				['id', ID1_TRACK_ID],
				['present', 1 if target else 0],
				['color', color_name],
				['r', _format_number(r)],
				['g', _format_number(g)],
				['b', _format_number(b)],
				['hue', _format_number(hue)],
				['saturation', _format_number(saturation)],
				['value', _format_number(value)],
				['dwell', _format_number(dwell, 3)],
				['timestamp', person_timestamp],
			]
		)


def _write_tracking_payload(payload):
	people = payload.get('people', payload.get('tracks', []))
	timestamp = payload.get('timestamp', 0)

	people_rows = []
	for person in people:
		person_timestamp = person.get('timestamp', timestamp)
		people_rows.append([
			person.get('id', ''),
			person_timestamp,
			_format_number(person.get('x')),
			_format_number(person.get('y')),
			_format_number(person.get('w')),
			_format_number(person.get('h')),
			person.get('color', 'Unknown'),
			_format_number(person.get('dwell'), 3),
		])

	people_dat = op(PEOPLE_DAT)
	if people_dat is not None:
		_clear_and_write_table(
			people_dat,
			['id', 'timestamp', 'x', 'y', 'w', 'h', 'color', 'dwell'],
			people_rows
		)

	info_dat = op(INFO_DAT)
	if info_dat is not None:
		_clear_and_write_table(
			info_dat,
			['key', 'value'],
			[
				['type', payload.get('type', '')],
				['timestamp', timestamp],
				['count', len(people)],
				['width', payload.get('width', 0)],
				['height', payload.get('height', 0)],
			]
		)

	_write_id1_color(people, timestamp)


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
	try:
		payload = json.loads(message)
	except Exception as err:
		debug('Phonecam WebSocket JSON parse error: {}'.format(err))
		return

	if payload.get('type') == 'tracking':
		_write_tracking_payload(payload)
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
