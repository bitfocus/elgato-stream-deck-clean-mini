'use strict';

// Native
const EventEmitter = require('events');

// Packages
const HID = require('node-hid');

const NUM_KEYS = 6;
const PAGE_PACKET_SIZE = 1024;
const PAGE1_PACKET_SIZE = PAGE_PACKET_SIZE-70;
const PAGE2_PACKET_SIZE = PAGE_PACKET_SIZE-16;
const ICON_SIZE = 80;
const ICON_BYTES = ICON_SIZE * ICON_SIZE * 3;
const IMAGE_SIZE = 72;
// Commented: const NUM_BUTTON_COLUMNS = 5;
// Commented: const NUM_BUTTON_ROWS = 3;

class StreamDeck extends EventEmitter {
	/**
	 * The pixel size of an icon written to the Stream Deck key.
	 *
	 * @readonly
	 */
	static get ICON_SIZE() {
		return ICON_SIZE;
	}

	/**
	 * Checks a value is a valid RGB value. A number between 0 and 255.
	 *
	 * @static
	 * @param {number} value The number to check
	 */
	static checkRGBValue(value) {
		if (value < 0 || value > 255) {
			throw new TypeError('Expected a valid color RGB value 0 - 255');
		}
	}

	/**
	 * Checks a keyIndex is a valid key for a stream deck. A number between 0 and 14.
	 *
	 * @static
	 * @param {number} keyIndex The keyIndex to check
	 */
	static checkValidKeyIndex(keyIndex) {
		if (keyIndex < 0 || keyIndex > 5) {
			throw new TypeError('Expected a valid keyIndex 0 - 5');
		}
	}

	/**
	 * Pads a given buffer till padLength with 0s.
	 *
	 * @private
	 * @param {Buffer} buffer Buffer to pad
	 * @param {number} padLength The length to pad to
	 * @returns {Buffer} The Buffer padded to the length requested
	 */
	static padBufferToLength(buffer, padLength) {
		return Buffer.concat([buffer, StreamDeck.createPadBuffer(padLength - buffer.length)]);
	}

	/**
	 * Returns an empty buffer (filled with zeroes) of the given length
	 *
	 * @private
	 * @param {number} padLength Length of the buffer
	 * @returns {Buffer}
	 */
	static createPadBuffer(padLength) {
		return Buffer.alloc(padLength);
	}

	/**
	 * Converts a buffer into an number[]. Used to supply the underlying
	 * node-hid device with the format it accepts.
	 *
	 * @static
	 * @param {Buffer} buffer Buffer to convert
	 * @returns {number[]} the converted buffer
	 */
	static bufferToIntArray(buffer) {
		const array = [];
		for (const pair of buffer.entries()) {
			array.push(pair[1]);
		}
		return array;
	}

	constructor(devicePath) {
		super();

		HID.setDriverType('libusb');

		if (typeof devicePath === 'undefined') {
			// Device path not provided, will then select any connected device.
			const devices = HID.devices();
			const connectedStreamDecks = devices.filter(device => {
				return device.vendorId === 0x0fd9 && device.productId === 0x0063;
			});
			if (!connectedStreamDecks.length) {
				throw new Error('No Stream Deck Minis are connected.');
			}
			this.device = new HID.HID(connectedStreamDecks[0].path);
		} else {
			this.device = new HID.HID(devicePath);
		}

		this.keyState = new Array(NUM_KEYS).fill(false);

		this.device.on('data', data => {
			// The first byte is a report ID, the last byte appears to be padding.
			// We strip these out for now.
			data = data.slice(1, data.length - 1);

			for (let i = 0; i < NUM_KEYS; i++) {
				const keyPressed = Boolean(data[i]);
				const stateChanged = keyPressed !== this.keyState[i];
				if (stateChanged) {
					this.keyState[i] = keyPressed;
					if (keyPressed) {
						this.emit('down', i);
					} else {
						this.emit('up', i);
					}
				}
			}
		});

		this.device.on('error', err => {
			this.emit('error', err);
		});
	}

	/**
	 * Writes a Buffer to the Stream Deck.
	 *
	 * @param {Buffer} buffer The buffer written to the Stream Deck
	 * @returns undefined
	 */
	write(buffer) {
		return this.device.write(StreamDeck.bufferToIntArray(buffer));
	}

	/**
	 * Sends a HID feature report to the Stream Deck.
	 *
	 * @param {Buffer} buffer The buffer send to the Stream Deck.
	 * @returns undefined
	 */
	sendFeatureReport(buffer) {
		return this.device.sendFeatureReport(StreamDeck.bufferToIntArray(buffer));
	}

	/**
	 * Fills the given key with a solid color.
	 *
	 * @param {number} keyIndex The key to fill 0 - 14
	 * @param {number} r The color's red value. 0 - 255
	 * @param {number} g The color's green value. 0 - 255
	 * @param {number} b The color's blue value. 0 -255
	 */
	fillColor(keyIndex, r, g, b) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		StreamDeck.checkRGBValue(r);
		StreamDeck.checkRGBValue(g);
		StreamDeck.checkRGBValue(b);

		const pixel = Buffer.from([b, g, r]);
		this._writePage1(keyIndex, Buffer.alloc(PAGE1_PACKET_SIZE, pixel));
		var count = 0;
		for (var i = PAGE1_PACKET_SIZE; i < ICON_BYTES; i += PAGE2_PACKET_SIZE) {
			this._writePage2(keyIndex, ++count, Buffer.alloc(Math.min(PAGE2_PACKET_SIZE, ICON_BYTES-i), pixel));
		}
	}

	flipCoordinate(x, y) {
		return (3 * IMAGE_SIZE * y) + ((IMAGE_SIZE - 1 - x) * 3);
	}

	/**
	 * Fills the given key with an image in a Buffer. Centers 72x72 inside 80x80
	 *
	 * @param {number} keyIndex The key to fill 0 - 14
	 * @param {Buffer} imageBuffer
	 */
	fillImage(keyIndex, imageBuffer) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		if (imageBuffer.length !== 15552) {
			throw new RangeError(`Expected image buffer of length 15552, got length ${imageBuffer.length}`);
		}

		let pixels = [];

		for (let i = 0; i < 40; ++i) {
			pixels.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
			pixels.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
		}

		for (let r = 0; r < IMAGE_SIZE; ++r) {
			const row = [];
			pixels.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
			for (let c = 0; c <  IMAGE_SIZE; ++c) {
				const cr = imageBuffer.readUInt8(this.flipCoordinate(r, c) + 2);
				const cg = imageBuffer.readUInt8(this.flipCoordinate(r, c) + 1);
				const cb = imageBuffer.readUInt8(this.flipCoordinate(r, c));
				row.push(cr, cg, cb);
			}
			pixels = pixels.concat(row);
			pixels.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
		}

		for (let i = 0; i < 40; ++i) {
			pixels.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
			pixels.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
		}

		this._writePage1(keyIndex, Buffer.from(pixels.slice(0, PAGE1_PACKET_SIZE)));
		var count = 0;
		for (let i = PAGE1_PACKET_SIZE; i < ICON_BYTES; i += PAGE2_PACKET_SIZE) {
			var buf = Buffer.from(pixels.slice(i, i + Math.min(PAGE2_PACKET_SIZE, ICON_BYTES-i)));
			this._writePage2(keyIndex, ++count, buf);
		}

	}

	/**
	 * Clears the given key.
	 *
	 * @param {number} keyIndex The key to clear 0 - 14
	 * @returns {undefined}
	 */
	clearKey(keyIndex) {
		StreamDeck.checkValidKeyIndex(keyIndex);
		return this.fillColor(keyIndex, 0, 0, 0);
	}

	/**
	 * Clears all keys.
	 *
	 * returns {undefined}
	 */
	clearAllKeys() {
		for (let keyIndex = 0; keyIndex < NUM_KEYS; keyIndex++) {
			this.clearKey(keyIndex);
		}
	}

	/**
	 * Sets the brightness of the keys on the Stream Deck
	 *
	 * @param {number} percentage The percentage brightness
	 */
	setBrightness(percentage) {
		if (percentage < 0 || percentage > 100) {
			throw new RangeError('Expected brightness percentage to be between 0 and 100');
		}

		const brightnessCommandBuffer = Buffer.from([0x05, 0x55, 0xaa, 0xd1, 0x01, percentage]);
		this.sendFeatureReport(StreamDeck.padBufferToLength(brightnessCommandBuffer, 17));
	}

	/**
	 * Writes a Stream Deck's page 1 headers and image data to the Stream Deck.
	 *
	 * @private
	 * @param {number} keyIndex The key to write to 0 - 14
	 * @param {Buffer} buffer Image data for page 1
	 * @returns {undefined}
	 */
	_writePage1(keyIndex, buffer) {
		const header = Buffer.from([
			0x02, 0x01, 0x00, 0x00, 0x00, parseInt(keyIndex) + 1, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x42, 0x4d, 0x36, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00,
			0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x01, 0x00, 0x18, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x4b, 0x00, 0x00, 0x13, 0x0b,	0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x00, 0x00,
		  0x00, 0x00, 0x00, 0x00, 0x00, 0x00
		]);

		const packet = StreamDeck.padBufferToLength(Buffer.concat([header, buffer]), PAGE_PACKET_SIZE);
		return this.write(packet);
	}

	/**
	 * Writes a Stream Deck's page 2 headers and image data to the Stream Deck.
	 *
	 * @private
	 * @param {number} keyIndex The key to write to 0 - 14
	 * @param {Buffer} buffer Image data for page 2
	 * @returns {undefined}
	 */
	_writePage2(keyIndex, bufIndex, buffer) {
		const header = Buffer.from([
			0x02, 0x01, bufIndex, 0x00, bufIndex == 0x13 ? 1 : 0, parseInt(keyIndex) + 1, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
		]);

		const packet = StreamDeck.padBufferToLength(Buffer.concat([header, buffer]), PAGE_PACKET_SIZE);
		return this.write(packet);
	}
}

module.exports = StreamDeck;
