/// <reference types="@citizenfx/server" />
/// <reference types="image-js" />

const imagejs = require('image-js');
const fs = require('fs');

const resName = GetCurrentResourceName();
const mainSavePath = `resources/${resName}/images`;
const config = JSON.parse(LoadResourceFile(GetCurrentResourceName(), "config.json"));

// Map clothing type to output folder name
const typeFolderMap = {
	'clothing_hat': 'Hats',
	'clothing_glasses': 'Glasses',
	'clothing_ears': 'Ears',
	'clothing_watch': 'Watches',
	'clothing_bracelet': 'Bracelets',
	'clothing_mask': 'Masks',
	'clothing_torso': 'Torsos',
	'clothing_pants': 'Pants',
	'clothing_bag': 'Bags',
	'clothing_shoes': 'Shoes',
	'clothing_accessory': 'Accessories',
	'clothing_undershirt': 'Undershirts',
	'clothing_vest': 'Bodyarmors',
	'clothing_top': 'Tops',
	'clothing_hair': 'Hair',
};

try {
	if (!fs.existsSync(mainSavePath)) {
		fs.mkdirSync(mainSavePath);
	}

	// Get all existing filenames to allow client to skip already-done items
	onNet('getExistingFiles', () => {
		const existingFiles = new Set();
		if (!config.overwriteExistingImages && fs.existsSync(mainSavePath)) {
			const folders = fs.readdirSync(mainSavePath);
			for (const folder of folders) {
				const folderPath = `${mainSavePath}/${folder}`;
				if (fs.statSync(folderPath).isDirectory()) {
					const files = fs.readdirSync(folderPath);
					for (const file of files) {
						if (file.endsWith('.png')) {
							// Filename is already without clothing_ prefix in the file itself
							existingFiles.add(file.replace('.png', ''));
						}
					}
				}
			}
		}
		emitNet('existingFilesResponse', source, Array.from(existingFiles));
		console.log(`[Greenscreener] Sent ${existingFiles.size} existing filenames to client`);
	});

	onNet('takeScreenshot', async (filename, type) => {
		const src = source;
		const folderName = typeFolderMap[type] || type.replace('clothing_', '');
		const savePath = `${mainSavePath}/${folderName}`;
		if (!fs.existsSync(savePath)) {
			fs.mkdirSync(savePath);
		}

		const fullFilePath = savePath + "/" + filename + ".png";

		// Check if file exists and overwrite is disabled
		if (!config.overwriteExistingImages && fs.existsSync(fullFilePath)) {
			if (config.debug) {
				console.log(
					`DEBUG: Skipping existing file: ${filename}.png (overwriteExistingImages = false)`
				);
			}
			emitNet('screenshotDone', src);
			return;
		}

		if (config.debug) {
			console.log(`DEBUG: Processing screenshot: ${filename}.png`);
		}

		exports['screenshot-basic'].requestClientScreenshot(
			src,
			{
				fileName: fullFilePath,
				encoding: 'png',
				quality: 1.0,
			},
			async (err, fileName) => {
				try {
					if (err) {
						console.error(`[Greenscreener] Screenshot error for ${filename}: ${err}`);
						emitNet('screenshotDone', src);
						return;
					}

					let image = await imagejs.Image.load(fileName);

					// Apply greenscreen removal - targets pure green, preserves yellow-green items
					const chromaSensitivity = config.chromaSensitivity || 'medium';
					// Thresholds based on sensitivity
					const thresholds = {
						soft: { greenDiff: 60, maxRed: 180, minGreen: 80 },
						medium: { greenDiff: 40, maxRed: 150, minGreen: 60 },
						hard: { greenDiff: 15, maxRed: 200, minGreen: 40 }
					};
					const t = thresholds[chromaSensitivity] || thresholds.medium;

					for (let x = 0; x < image.width; x++) {
						for (let y = 0; y < image.height; y++) {
							const pixelArr = image.getPixelXY(x, y);
							const r = pixelArr[0];
							const g = pixelArr[1];
							const b = pixelArr[2];
							const a = pixelArr[3];

							// Smarter chroma key:
							// - Green must be significantly higher than red AND blue
							// - Red must be below threshold (pure greenscreen has low red)
							// - This preserves yellow-green colors where red is higher
							const isGreenscreen =
								g > r + t.greenDiff &&
								g > b + t.greenDiff &&
								g > t.minGreen &&
								r < t.maxRed &&
								a > 0;

							if (isGreenscreen) {
								image.setPixelXY(x, y, [255, 255, 255, 0]);
							}
						}
					}

					// Crop image
					let minX = image.width;
					let maxX = -1;
					let minY = image.height;
					let maxY = -1;

					for (let x = 0; x < image.width; x++) {
						for (let y = 0; y < image.height; y++) {
							const pixelArr = image.getPixelXY(x, y);
							const alpha = pixelArr[3];

							// Use threshold of 128 to ignore semi-transparent artifacts/noise
							if (alpha > 128) {
								minX = Math.min(minX, x);
								maxX = Math.max(maxX, x);
								minY = Math.min(minY, y);
								maxY = Math.max(maxY, y);
							}
						}
					}


					// Save image as 1:1 square with centered content at target size
					if (maxX >= minX && maxY >= minY) {
						const targetSize = config.imageSize || 150;
						const contentWidth = maxX - minX + 1;
						const contentHeight = maxY - minY + 1;

						// Crop to content first
						const croppedImage = image.crop({
							x: minX,
							y: minY,
							width: contentWidth,
							height: contentHeight
						});

						// Create square canvas at content size first (for centering)
						const squareSize = Math.max(contentWidth, contentHeight);
						const squareImage = new imagejs.Image(squareSize, squareSize, { alpha: 1 });

						// Fill with transparent
						for (let x = 0; x < squareSize; x++) {
							for (let y = 0; y < squareSize; y++) {
								squareImage.setPixelXY(x, y, [255, 255, 255, 0]);
							}
						}

						// Calculate offset to center content
						const offsetX = Math.floor((squareSize - contentWidth) / 2);
						const offsetY = Math.floor((squareSize - contentHeight) / 2);

						// Copy cropped content to center of square
						for (let x = 0; x < contentWidth; x++) {
							for (let y = 0; y < contentHeight; y++) {
								const pixel = croppedImage.getPixelXY(x, y);
								squareImage.setPixelXY(x + offsetX, y + offsetY, pixel);
							}
						}

						// Resize to target size (e.g. 150x150)
						image = squareImage.resize({ width: targetSize, height: targetSize });
					}

					image.save(fileName);
					emitNet('screenshotDone', src);
				} catch (error) {
					console.error(`[Greenscreener] Image processing failed: ${filename} - ${error.message}`);
					emitNet('screenshotDone', src);
				}
			}
		);
	});
	onNet('printPedSettings', (pedPosition, pedRotation) => {
		console.log('\n========== PED SETTINGS ==========');
		console.log(`"pedPosition": {`);
		console.log(`    "x": ${pedPosition.x},`);
		console.log(`    "y": ${pedPosition.y},`);
		console.log(`    "z": ${pedPosition.z}`);
		console.log(`},`);
		console.log(`"pedRotation": {`);
		console.log(`    "x": ${pedRotation.x},`);
		console.log(`    "y": ${pedRotation.y},`);
		console.log(`    "z": ${pedRotation.z}`);
		console.log(`}`);
		console.log('==================================\n');
	});
} catch (error) {
	console.error(error.message);
}
