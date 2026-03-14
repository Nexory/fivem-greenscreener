/// <reference types="@citizenfx/client" />

const config = JSON.parse(LoadResourceFile(GetCurrentResourceName(), 'config.json'));

// Set of existing filenames (for skipping already-done items)
let existingFiles = new Set();

// Handler for receiving existing files from server
onNet('existingFilesResponse', (files) => {
	existingFiles = new Set(files);
	console.log(`[Greenscreener] Received ${existingFiles.size} existing filenames`);
});

// Request existing files from server
function requestExistingFiles() {
	return new Promise((resolve) => {
		const handler = (files) => {
			existingFiles = new Set(files);
			removeEventListener('existingFilesResponse', handler);
			resolve();
		};
		onNet('existingFilesResponse', handler);
		emitNet('getExistingFiles');
		// Timeout after 5 seconds
		setTimeout(() => resolve(), 5000);
	});
}

// Load clothing items from clothing_items.json (optional, for database-driven mode)
// Generate this file using: node extract_items.js <path-to-sql-file>
let clothingItems = { items: [] };
if (config.useDatabaseItems) {
	try {
		const itemsJson = LoadResourceFile(GetCurrentResourceName(), 'clothing_items.json');
		if (itemsJson) {
			const parsed = JSON.parse(itemsJson);
			clothingItems.items = (parsed.items || [])
				.filter(item => item.category !== 'clothing_undershirt')
				.map(item => ({ ...item, label: item.label || '' }));
			console.log(`[Greenscreener] Loaded ${clothingItems.items.length} items from clothing_items.json`);
		} else {
			console.log('[Greenscreener] Warning: clothing_items.json not found. Run "node extract_items.js" to generate it, or set useDatabaseItems to false.');
		}
	} catch (e) {
		console.log('[Greenscreener] Warning: Could not load clothing_items.json - ' + e.message);
	}
}

// Category to component mapping (for filtering)
const categoryToComponent = {
	'clothing_mask': { component: 1, isProp: false },
	'clothing_top': { component: 11, isProp: false },
	'clothing_pants': { component: 4, isProp: false },
	'clothing_shoes': { component: 6, isProp: false },
	'clothing_torso': { component: 3, isProp: false },
	'clothing_bag': { component: 5, isProp: false },
	'clothing_accessory': { component: 7, isProp: false },
	'clothing_vest': { component: 9, isProp: false },
	'clothing_hat': { component: 0, isProp: true },
	'clothing_glasses': { component: 1, isProp: true },
	'clothing_ears': { component: 2, isProp: true },
	'clothing_watch': { component: 6, isProp: true },
	'clothing_bracelet': { component: 7, isProp: true },
	'clothing_hair': { component: 2, isProp: false },
};

// Get items for a specific component and gender from database
function getDatabaseItems(componentId, isProp, gender, activeCategories = null) {
	if (!clothingItems.items || clothingItems.items.length === 0) return null;

	// Include both gender-specific items AND 'both' (unisex) items
	const items = clothingItems.items.filter(item =>
		item.component_id === componentId &&
		item.is_prop === isProp &&
		(item.gender === gender || item.gender === 'both')
	);

	// Apply category filter if specified (runtime categories take priority)
	const categories = activeCategories || config.categories;
	if (categories && categories.length > 0) {
		return items.filter(item => categories.includes(item.category));
	}

	return items;
}

// Check if a category should be processed based on config.categories filter
function shouldProcessCategory(categoryName) {
	if (!config.categories || config.categories.length === 0) return true;
	return config.categories.includes(categoryName.toLowerCase().replace(/\s+/g, '_'));
}

const Delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Screenshot confirmation from server
let screenshotResolve = null;
onNet('screenshotDone', () => {
	if (screenshotResolve) {
		screenshotResolve();
		screenshotResolve = null;
	}
});

function waitForScreenshotDone(timeoutMs = 800) {
	return new Promise(resolve => {
		screenshotResolve = resolve;
		setTimeout(() => {
			if (screenshotResolve === resolve) {
				screenshotResolve = null;
				resolve(); // Timeout-Fallback
			}
		}, timeoutMs);
	});
}

let cam;
let camInfo;
let ped;
let interval;
let greenScreenObject = null;
const playerId = PlayerId();
let QBCore = null;
let lastAppliedRotationZ = null; // Track rotation changes for camera recreation
let lastEarSide = null; // Track ear side changes for camera recreation

async function spawnGreenScreen() {
	const hash = GetHashKey('jim_g_green_screen_v1');
	RequestModel(hash);
	let timeout = 0;
	while (!HasModelLoaded(hash) && timeout < 5000) {
		await Delay(100);
		timeout += 100;
	}
	if (!HasModelLoaded(hash)) {
		console.log('Greenscreen model failed to load');
		return;
	}
	if (greenScreenObject && DoesEntityExist(greenScreenObject)) {
		DeleteEntity(greenScreenObject);
	}
	greenScreenObject = CreateObjectNoOffset(hash, config.greenScreenObjectPosition.x, config.greenScreenObjectPosition.y, config.greenScreenObjectPosition.z, false, false, false);
	SetEntityRotation(greenScreenObject, 0, 0, config.pedRotation.z, 0, false);
	FreezeEntityPosition(greenScreenObject, true);
	SetModelAsNoLongerNeeded(hash);
}

function deleteGreenScreen() {
	if (greenScreenObject && DoesEntityExist(greenScreenObject)) {
		DeleteEntity(greenScreenObject);
		greenScreenObject = null;
	}
}

if (config.useQBVehicles) {
	QBCore = exports[config.coreResourceName].GetCoreObject();
}

// Auto-spawn player when resource starts to clear "Awaiting scripts" warning
setTimeout(() => {
	triggerSpawn();
}, 1000);

async function takeScreenshotForComponent(pedType, type, component, drawable, texture, cameraSettings, itemName = null, itemLabel = null) {
	const cameraInfo = cameraSettings ? cameraSettings : config.cameraSettings[type][component];
	const categoryName = cameraInfo.name.toLowerCase().replace(/\s+/g, '_');
	const catName = cameraInfo.name;

	// Determine ear side from label: (L) = links, (R) = rechts, otherwise both
	let earSide = null;
	if (catName === 'clothing_ears' && itemLabel) {
		if (itemLabel.includes('(L)')) earSide = 'L';
		else if (itemLabel.includes('(R)')) earSide = 'R';
		else earSide = 'both';
	}

	setWeatherTime();

	await Delay(150);

	// Check if camera needs recreation - zPos, fov, rotation, or ear side changed
	const rotationChanged = lastAppliedRotationZ !== config.pedRotation.z;
	const earSideChanged = catName === 'clothing_ears' && lastEarSide !== earSide;
	if (!camInfo || camInfo.zPos !== cameraInfo.zPos || camInfo.fov !== cameraInfo.fov || rotationChanged || earSideChanged) {
		camInfo = cameraInfo;
		lastAppliedRotationZ = config.pedRotation.z;
		if (catName === 'clothing_ears') lastEarSide = earSide;

		if (cam) {
			DestroyAllCams(true);
			DestroyCam(cam, true);
			cam = null;
		}

		// 1. Position ped - use per-category overrides from categoryOverrides
		const overrides = categoryOverrides[catName] || {};
		const pedPosY = overrides.pedY !== undefined ? overrides.pedY : config.pedPosition.y;
		FreezeEntityPosition(ped, false);
		SetEntityCoordsNoOffset(ped, config.pedPosition.x, pedPosY, config.pedPosition.z, false, false, false);
		SetEntityHeading(ped, config.pedRotation.z);
		await Delay(50);

		// 2. Get forward vector and create camera (rotated 180°)
		const [playerX, playerY, playerZ] = GetEntityCoords(ped);
		const [fwdX, fwdY, fwdZ] = GetEntityForwardVector(ped);

		// Camera in front of ped
		const fwdPos = {
			x: playerX + fwdX * 1.2,
			y: playerY + fwdY * 1.2,
			z: playerZ + fwdZ + camInfo.zPos,
		};

		cam = CreateCamWithParams('DEFAULT_SCRIPTED_CAMERA', fwdPos.x, fwdPos.y, fwdPos.z, 0, 0, 0, camInfo.fov, true, 0);
		PointCamAtCoord(cam, playerX, playerY, playerZ + camInfo.zPos);
		SetCamActive(cam, true);
		RenderScriptCams(true, false, 0, true, false, 0);

		// 3. Rotate ped - use per-category overrides
		let basePedZ = overrides.basePedZ !== undefined ? overrides.basePedZ : config.pedRotation.z;
		const pedX = overrides.pedRotX !== undefined ? overrides.pedRotX : config.pedRotation.x;
		let extraRotation = overrides.extraRotation || 0.0;

		// Ears: rotate based on side (L/R/both)
		if (catName === 'clothing_ears' && earSide) {
			if (earSide === 'L') extraRotation = 90.0;       // Left ear → show right side
			else if (earSide === 'R') extraRotation = -90.0;  // Right ear → show left side
			// 'both' → default rotation (slightly angled)
		}

		const pedHeadingToCamera = basePedZ + 180.0 + extraRotation;

		// Debug logging
		const earInfo = earSide ? `, Ear: ${earSide}` : '';
		console.log(`[DEBUG] Category: ${catName}, Ped pos Y=${pedPosY}, Rotation: x=${pedX}, y=0, z=${pedHeadingToCamera} (base=${basePedZ} +180 +extra=${extraRotation})${earInfo}`);

		// Apply rotation to face camera
		ClearPedTasksImmediately(ped);
		SetEntityRotation(ped, pedX, 0.0, pedHeadingToCamera, 2, true);
		await Delay(50); // Let rotation take effect before freezing
		FreezeEntityPosition(ped, true);
		TaskStandStill(ped, -1);
	}

	await Delay(50);
	hideTxAdminWarning();
	// Use item name from database if provided, otherwise build filename
	let filename;
	if (itemName) {
		filename = itemName;
	} else {
		const gender = pedType === 'male' ? 'm' : 'f';
		const textureVal = texture !== null && texture !== undefined ? texture : 0;
		filename = `clothing_${categoryName}_${gender}_${drawable}_${textureVal}`;
	}
	emitNet('takeScreenshot', filename, categoryName);
	await waitForScreenshotDone(800);
	return;
}

async function takeScreenshotForObject(object, hash) {

	setWeatherTime();

	await Delay(150);

	if (cam) {
		DestroyAllCams(true);
		DestroyCam(cam, true);
		cam = null;
	}

	let [[minDimX, minDimY, minDimZ], [maxDimX, maxDimY, maxDimZ]] = GetModelDimensions(hash);
	let modelSize = {
		x: maxDimX - minDimX,
		y: maxDimY - minDimY,
		z: maxDimZ - minDimZ
	}
	let fov = Math.min(Math.max(modelSize.x, modelSize.z) / 0.15 * 10, 60);


	const [objectX, objectY, objectZ] = GetEntityCoords(object, false);
	const [fwdX, fwdY, fwdZ] = GetEntityForwardVector(object);

	const center = {
		x: objectX + (minDimX + maxDimX) / 2,
		y: objectY + (minDimY + maxDimY) / 2,
		z: objectZ + (minDimZ + maxDimZ) / 2,
	}

	const fwdPos = {
		x: center.x + fwdX * 1.2 + Math.max(modelSize.x, modelSize.z) / 2,
		y: center.y + fwdY * 1.2 + Math.max(modelSize.x, modelSize.z) / 2,
		z: center.z + fwdZ,
	};

	console.log(modelSize.x, modelSize.z)

	cam = CreateCamWithParams('DEFAULT_SCRIPTED_CAMERA', fwdPos.x, fwdPos.y, fwdPos.z, 0, 0, 0, fov, true, 0);

	PointCamAtCoord(cam, center.x, center.y, center.z);
	SetCamActive(cam, true);
	RenderScriptCams(true, false, 0, true, false, 0);

	await Delay(50);

	hideTxAdminWarning();
	await Delay(50);
	emitNet('takeScreenshot', `${hash}`, 'objects');

	await Delay(600);

	return;

}

async function takeScreenshotForVehicle(vehicle, hash, model) {
	setWeatherTime();

	await Delay(150);

	if (cam) {
		DestroyAllCams(true);
		DestroyCam(cam, true);
		cam = null;
	}

	let [[minDimX, minDimY, minDimZ], [maxDimX, maxDimY, maxDimZ]] = GetModelDimensions(hash);
	let modelSize = {
		x: maxDimX - minDimX,
		y: maxDimY - minDimY,
		z: maxDimZ - minDimZ
	}
	let fov = Math.min(Math.max(modelSize.x, modelSize.y, modelSize.z) / 0.15 * 10, 60);

	const [objectX, objectY, objectZ] = GetEntityCoords(vehicle, false);

	const center = {
		x: objectX + (minDimX + maxDimX) / 2,
		y: objectY + (minDimY + maxDimY) / 2,
		z: objectZ + (minDimZ + maxDimZ) / 2,
	}

	let camPos = {
		x: center.x + (Math.max(modelSize.x, modelSize.y, modelSize.z) + 2) * Math.cos(340),
		y: center.y + (Math.max(modelSize.x, modelSize.y, modelSize.z) + 2) * Math.sin(340),
		z: center.z + modelSize.z / 2,
	}

	cam = CreateCamWithParams('DEFAULT_SCRIPTED_CAMERA', camPos.x, camPos.y, camPos.z, 0, 0, 0, fov, true, 0);

	PointCamAtCoord(cam, center.x, center.y, center.z);
	SetCamActive(cam, true);
	RenderScriptCams(true, false, 0, true, false, 0);

	await Delay(50);

	hideTxAdminWarning();
	await Delay(50);
	emitNet('takeScreenshot', `${model}`, 'vehicles');

	await Delay(600);

	return;

}

function SetPedOnGround() {
	const [x, y, z] = GetEntityCoords(ped, false);
	const [retval, ground] = GetGroundZFor_3dCoord(x, y, z, 0, false);
	SetEntityCoords(ped, x, y, ground, false, false, false, false);

}

function ClearAllPedProps() {
	for (const prop of Object.keys(config.cameraSettings.PROPS)) {
		ClearPedProp(ped, parseInt(prop));
	}
}

async function ResetPedComponents() {

	if (config.debug) console.log(`DEBUG: Resetting Ped Components`);

	SetPedDefaultComponentVariation(ped);

	await Delay(150);

	SetPedComponentVariation(ped, 0, 0, 1, 0); // Head
	SetPedComponentVariation(ped, 1, -1, 0, 0); // Mask
	SetPedComponentVariation(ped, 2, -1, 0, 0); // Hair
	SetPedComponentVariation(ped, 7, -1, 0, 0); // Accessories
	SetPedComponentVariation(ped, 5, -1, 0, 0); // Bags
	SetPedComponentVariation(ped, 6, -1, 0, 0); // Shoes
	SetPedComponentVariation(ped, 9, -1, 0, 0); // Armor
	SetPedComponentVariation(ped, 3, -1, 0, 0); // Torso
	SetPedComponentVariation(ped, 8, -1, 0, 0); // Undershirt
	SetPedComponentVariation(ped, 4, -1, 0, 0); // Legs
	SetPedComponentVariation(ped, 11, -1, 0, 0); // Top
	SetPedComponentVariation(ped, 10, -1, 0, 0); // Decal
	SetPedHairColor(ped, 45, 15);

	ClearAllPedProps();

	return;
}

function setWeatherTime() {
	if (config.debug) console.log(`DEBUG: Setting Weather & Time`);
	// Disable network weather sync so our changes stick
	SetWeatherOwnedByNetwork(false);
	// Clear all weather effects
	ClearOverrideWeather();
	ClearWeatherTypePersist();
	SetRainLevel(0.0);
	SetWindSpeed(0.0);
	SetWindDirection(0.0);
	// Set clean weather
	SetWeatherTypePersist('EXTRASUNNY');
	SetWeatherTypeNow('EXTRASUNNY');
	SetWeatherTypeNowPersist('EXTRASUNNY');
	SetOverrideWeather('EXTRASUNNY');
	// Set time
	NetworkOverrideClockTime(12, 0, 0);
	NetworkOverrideClockMillisecondsPerGameMinute(1000000);
	// Clear particles and effects in range (larger radius for airport debris)
	RemoveParticleFxInRange(config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, 500.0);
	ClearAreaOfProjectiles(config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, 500.0, false);
	// Clear other entities that might have particle effects
	ClearAreaOfCops(config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, 500.0, 0);
	ClearArea(config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, 500.0, true, false, false, false);
	// Clear timecycle modifiers (visual effects)
	ClearTimecycleModifier();
	ClearExtraTimecycleModifier();
	// Disable artificial lights state changes
	SetArtificialLightsState(false);
	SetArtificialLightsStateAffectsVehicles(false);
}

function triggerSpawn() {
	// Trigger spawnmanager to mark player as spawned
	if (GetResourceState('spawnmanager') === 'started') {
		exports.spawnmanager.setAutoSpawn(true);
		exports.spawnmanager.setAutoSpawnCallback(() => {
			// Spawn at ground level, not the high greenscreen position
			exports.spawnmanager.spawnPlayer({
				x: -1300,
				y: -3400,
				z: 14.0,
				heading: config.pedRotation.z,
				model: 'mp_m_freemode_01',
				skipFade: true
			}, () => {
				emit('playerSpawned');
			});
		});
		exports.spawnmanager.forceRespawn();
	}
}

function hideTxAdminWarning() {
	// Try to hide txAdmin's "Awaiting scripts" warning
	// This is rendered via NUI, so we need to use txAdmin's events
	if (GetResourceState('monitor') === 'started') {
		emit('txAdmin:menu:closeMenu');
		// Try to set the player as "spawned" to clear the warning
		GlobalState.isPlayerReady = true;
		// Try to emit player ready/spawned events
		emit('playerSpawned');
		emit('txcl:setWarningVisibility', false);
		// Try sending NUI message to hide warning
		SendNuiMessage(JSON.stringify({ action: 'hideWarning' }));
	}
	// Disable player blips and other overlays
	SetPlayerBlipPositionThisFrame(-5000.0, -5000.0);
	// Try to clear any scaleform/text overlays
	HideLoadingOnFadeThisFrame();
	SetTextRenderId(1);
	// Try to override NUI focus to potentially clear overlays
	SetNuiFocusKeepInput(false);
	// Hide chat - multiple methods for different chat resources
	emit('chat:clear');
	emit('chat:hide', true);
	SetTextChatEnabled(false);
	// Try NUI method for default FiveM chat
	SendNuiMessage(JSON.stringify({ type: 'ON_SCREEN_STATE_CHANGE', display: false, input: false }));
}

function stopWeatherResource() {
	if (config.debug) console.log(`DEBUG: Stopping Weather Resource`);
	if ((GetResourceState('qb-weathersync') == 'started') || (GetResourceState('qbx_weathersync') == 'started')) {
		TriggerEvent('qb-weathersync:client:DisableSync');
		return true;
	} else if (GetResourceState('weathersync') == 'started') {
		TriggerEvent('weathersync:toggleSync')
		return true;
	} else if (GetResourceState('esx_wsync') == 'started') {
		SendNUIMessage({
			error: 'weathersync',
		});
		return false;
	} else if (GetResourceState('cd_easytime') == 'started') {
		TriggerEvent('cd_easytime:PauseSync', false)
		return true;
	} else if (GetResourceState('vSync') == 'started' || GetResourceState('Renewed-Weathersync') == 'started') {
		TriggerEvent('vSync:toggle', false)
		return true;
	}
	return true;
};

function startWeatherResource() {
	if (config.debug) console.log(`DEBUG: Starting Weather Resource again`);
	if ((GetResourceState('qb-weathersync') == 'started') || (GetResourceState('qbx_weathersync') == 'started')) {
		TriggerEvent('qb-weathersync:client:EnableSync');
	} else if (GetResourceState('weathersync') == 'started') {
		TriggerEvent('weathersync:toggleSync')
	} else if (GetResourceState('cd_easytime') == 'started') {
		TriggerEvent('cd_easytime:PauseSync', true)
	} else if (GetResourceState('vSync') == 'started' || GetResourceState('Renewed-Weathersync') == 'started') {
		TriggerEvent('vSync:toggle', true)
	}
}

async function LoadComponentVariation(ped, component, drawable, texture) {
	texture = texture || 0;

	if (config.debug) console.log(`DEBUG: Loading Component Variation: ${component} ${drawable} ${texture}`);

	SetPedPreloadVariationData(ped, component, drawable, texture);
	let elapsed = 0;
	while (!HasPedPreloadVariationDataFinished(ped)) {
		await Delay(50);
		elapsed += 50;
		if (elapsed > 5000) {
			console.warn(`[Greenscreener] Preload timeout: Component ${component}, Drawable ${drawable}, Texture ${texture}`);
			return false;
		}
	}
	SetPedComponentVariation(ped, component, drawable, texture, 0);

	return true;
}

async function LoadPropVariation(ped, component, prop, texture) {
	texture = texture || 0;

	if (config.debug) console.log(`DEBUG: Loading Prop Variation: ${component} ${prop} ${texture}`);

	SetPedPreloadPropData(ped, component, prop, texture);
	let elapsed = 0;
	while (!HasPedPreloadPropDataFinished(ped)) {
		await Delay(50);
		elapsed += 50;
		if (elapsed > 5000) {
			console.warn(`[Greenscreener] Preload timeout: Prop ${component}, Drawable ${prop}, Texture ${texture}`);
			return false;
		}
	}
	ClearPedProp(ped, component);
	SetPedPropIndex(ped, component, prop, texture, 0);

	return true;
}

function createGreenScreenVehicle(vehicleHash, vehicleModel) {
	return new Promise(async(resolve, reject) => {
		if (config.debug) console.log(`DEBUG: Spawning Vehicle ${vehicleModel}`);
		const timeout = setTimeout(() => {
			resolve(null);
		}, config.vehicleSpawnTimeout)
		if (!HasModelLoaded(vehicleHash)) {
			RequestModel(vehicleHash);
			while (!HasModelLoaded(vehicleHash)) {
				await Delay(100);
			}
		}
		const vehicle = CreateVehicle(vehicleHash, config.greenScreenVehiclePosition.x, config.greenScreenVehiclePosition.y, config.greenScreenVehiclePosition.z, 0, true, true);
		if (vehicle === 0) {
			clearTimeout(timeout);
			resolve(null);
		}
		clearTimeout(timeout);
		resolve(vehicle);
	});
}


// Command to change camera/ped settings in-game via F8 console
// Usage: /gs_set <category> <property> <value>
// Examples:
//   /gs_set clothing_torso zPos -0.5
//   /gs_set clothing_torso fov 35
//   /gs_set clothing_torso pedY -3419.5
//   /gs_set clothing_torso pedX -45
//   /gs_set clothing_torso pedZ 335
//   /gs_set clothing_torso extraRot 90
//   /gs_set clothing_mask zPos 0.65
//   /gs_show clothing_torso          (show current values)
//   /gs_show                          (show all overrides)

// Per-category overrides (modifiable at runtime)
const categoryOverrides = {
	'clothing_torso': { pedY: -3419.2, pedRotX: -45, basePedZ: 335, extraRotation: 90.0 },
	'clothing_shoes': { extraRotation: 45.0 },
	'clothing_bag': { extraRotation: 180.0 },
	'clothing_glasses': { extraRotation: 15.0 },
	'clothing_hat': { extraRotation: 45.0 },
	'clothing_watch': { pedY: -3419.1, pedRotX: -45, basePedZ: 335, extraRotation: -90.0 },
	'clothing_bracelet': { pedY: -3419.1, pedRotX: -45, basePedZ: 335, extraRotation: 90.0 },
};

RegisterCommand('gs_set', (source, args) => {
	if (args.length < 3) {
		console.log('[Greenscreener] Usage: /gs_set <category> <property> <value>');
		console.log('[Greenscreener] Properties: zPos, fov, pedY, pedRotX, basePedZ, extraRot');
		return;
	}

	const category = args[0].toLowerCase();
	const property = args[1].toLowerCase();
	const value = parseFloat(args[2]);

	if (isNaN(value)) {
		console.log(`[Greenscreener] Invalid value: ${args[2]}`);
		return;
	}

	// Ensure override entry exists
	if (!categoryOverrides[category]) categoryOverrides[category] = {};

	// Map property names to override keys
	const propMap = {
		'zpos': 'zPos',
		'fov': 'fov',
		'pedy': 'pedY',
		'pedrotx': 'pedRotX',
		'basepedz': 'basePedZ',
		'extrarot': 'extraRotation',
	};

	const overrideKey = propMap[property];
	if (!overrideKey) {
		console.log(`[Greenscreener] Unknown property: ${property}`);
		console.log(`[Greenscreener] Valid: zPos, fov, pedY, pedRotX, basePedZ, extraRot`);
		return;
	}

	// For zPos and fov, update config.cameraSettings directly
	if (overrideKey === 'zPos' || overrideKey === 'fov') {
		// Find the camera setting entry by name
		for (const type of ['CLOTHING', 'PROPS']) {
			for (const comp in config.cameraSettings[type]) {
				if (config.cameraSettings[type][comp].name === category) {
					config.cameraSettings[type][comp][overrideKey] = value;
					console.log(`[Greenscreener] Set ${category}.${overrideKey} = ${value} (camera config)`);
					// Force camera rebuild
					camInfo = null;
					return;
				}
			}
		}
		console.log(`[Greenscreener] Category not found in cameraSettings: ${category}`);
		return;
	}

	categoryOverrides[category][overrideKey] = value;
	// Force camera rebuild
	camInfo = null;
	console.log(`[Greenscreener] Set ${category}.${overrideKey} = ${value}`);
}, false);

RegisterCommand('gs_show', (source, args) => {
	const category = args[0] ? args[0].toLowerCase() : null;

	if (category) {
		const overrides = categoryOverrides[category] || {};
		// Find camera config
		let camConfig = null;
		for (const type of ['CLOTHING', 'PROPS']) {
			for (const comp in config.cameraSettings[type]) {
				if (config.cameraSettings[type][comp].name === category) {
					camConfig = config.cameraSettings[type][comp];
					break;
				}
			}
			if (camConfig) break;
		}
		console.log(`[Greenscreener] === ${category} ===`);
		if (camConfig) console.log(`  Camera: zPos=${camConfig.zPos}, fov=${camConfig.fov}`);
		console.log(`  Overrides: ${JSON.stringify(overrides)}`);
		console.log(`  Global pedPosition: ${JSON.stringify(config.pedPosition)}`);
		console.log(`  Global pedRotation: ${JSON.stringify(config.pedRotation)}`);
	} else {
		console.log('[Greenscreener] === All Category Overrides ===');
		for (const cat in categoryOverrides) {
			console.log(`  ${cat}: ${JSON.stringify(categoryOverrides[cat])}`);
		}
	}
}, false);

RegisterCommand('screenshot', async (source, args) => {
	// Parse optional category argument: /screenshot [category]
	// Examples: /screenshot torso, /screenshot mask, /screenshot (all)
	// Auto-prefix "clothing_" if not present
	let categoryArg = args[0] ? args[0].toLowerCase() : null;
	const validCategories = Object.keys(categoryToComponent);

	if (categoryArg && !validCategories.includes(categoryArg)) {
		// Try with clothing_ prefix
		const prefixed = 'clothing_' + categoryArg;
		if (validCategories.includes(prefixed)) {
			categoryArg = prefixed;
		} else {
			const shortNames = validCategories.map(c => c.replace('clothing_', ''));
			console.log(`[Greenscreener] Invalid category: ${args[0]}`);
			console.log(`[Greenscreener] Valid categories: ${shortNames.join(', ')}`);
			return;
		}
	}

	// Set runtime category filter (overrides config.categories for this run)
	const runtimeCategories = categoryArg ? [categoryArg] : null;

	const modelHashes = [GetHashKey('mp_m_freemode_01'), GetHashKey('mp_f_freemode_01')];

	SendNUIMessage({
		start: true,
	});

	if (categoryArg) {
		console.log(`[Greenscreener] Starting screenshot for category: ${categoryArg}`);
	} else {
		console.log(`[Greenscreener] Starting screenshot for all categories`);
	}

	// Pre-fetch existing files to skip already-done items (if overwrite is disabled)
	if (!config.overwriteExistingImages) {
		console.log(`[Greenscreener] Fetching existing files...`);
		await requestExistingFiles();
		console.log(`[Greenscreener] Will skip ${existingFiles.size} existing files`);
	}

	if (!stopWeatherResource()) return;

	DisableIdleCamera(true);
	DisplayHud(false);
	DisplayRadar(false);
	// Hide chat at start
	emit('chat:clear');
	emit('chat:hide', true);
	SetTextChatEnabled(false);
	await spawnGreenScreen();

	await Delay(100);

	for (const modelHash of modelHashes) {
		if (IsModelValid(modelHash)) {
			if (!HasModelLoaded(modelHash)) {
				RequestModel(modelHash);
				while (!HasModelLoaded(modelHash)) {
					await Delay(100);
				}
			}

			SetPlayerModel(playerId, modelHash);
			await Delay(150);
			SetModelAsNoLongerNeeded(modelHash);

			await Delay(150);

			ped = PlayerPedId();

			const pedType = modelHash === GetHashKey('mp_m_freemode_01') ? 'male' : 'female';
			// Position and freeze ped
			SetEntityCoordsNoOffset(ped, config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, false, false, false);
			FreezeEntityPosition(ped, true);
			// Disable idle animations
			ClearPedTasks(ped);
			ClearPedTasksImmediately(ped);
			SetPedCanPlayAmbientAnims(ped, false);
			SetPedCanPlayGestureAnims(ped, false);
			SetPedCanPlayVisemeAnims(ped, false, false);
			SetPedConfigFlag(ped, 292, true); // Disable ambient clips
			TaskStandStill(ped, -1);
			SetPlayerControl(playerId, false, 0);
			await Delay(100);

			interval = setInterval(() => {
				HideHudAndRadarThisFrame();
				for (let i = 1; i <= 22; i++) {
					HideHudComponentThisFrame(i);
				}
				hideTxAdminWarning();

				// Disable controls so we can detect them
				DisableControlAction(0, 32, true); // W
				DisableControlAction(0, 33, true); // S
				DisableControlAction(0, 34, true); // A
				DisableControlAction(0, 35, true); // D
				DisableControlAction(0, 44, true); // Q
				DisableControlAction(0, 38, true); // E
				DisableControlAction(0, 172, true); // Arrow Up
				DisableControlAction(0, 173, true); // Arrow Down
				DisableControlAction(0, 174, true); // Arrow Left
				DisableControlAction(0, 175, true); // Arrow Right
				DisableControlAction(0, 0, true); // V

				// Adjustment controls - WASD for ped position, Q/E for Z, Arrows for rotation
				let positionChanged = false;
				let rotationChanged = false;
				if (IsDisabledControlJustPressed(0, 32)) { config.pedPosition.y += 0.5; positionChanged = true; } // W - forward (Y+)
				if (IsDisabledControlJustPressed(0, 33)) { config.pedPosition.y -= 0.5; positionChanged = true; } // S - back (Y-)
				if (IsDisabledControlJustPressed(0, 34)) { config.pedPosition.x -= 0.5; positionChanged = true; } // A - left (X-)
				if (IsDisabledControlJustPressed(0, 35)) { config.pedPosition.x += 0.5; positionChanged = true; } // D - right (X+)
				if (IsDisabledControlJustPressed(0, 44)) { config.pedPosition.z -= 0.5; positionChanged = true; } // Q - down (Z-)
				if (IsDisabledControlJustPressed(0, 38)) { config.pedPosition.z += 0.5; positionChanged = true; } // E - up (Z+)
				if (IsDisabledControlJustPressed(0, 172)) { config.pedRotation.x += 5; rotationChanged = true; } // Arrow Up - tilt up
				if (IsDisabledControlJustPressed(0, 173)) { config.pedRotation.x -= 5; rotationChanged = true; } // Arrow Down - tilt down
				if (IsDisabledControlJustPressed(0, 174)) { config.pedRotation.z += 5; rotationChanged = true; } // Arrow Left - rotate left
				if (IsDisabledControlJustPressed(0, 175)) { config.pedRotation.z -= 5; rotationChanged = true; } // Arrow Right - rotate right
				if (IsDisabledControlJustPressed(0, 0)) emitNet('printPedSettings', config.pedPosition, config.pedRotation); // V - print

				// Apply rotation when changed - only rotate ped, don't move camera
				if (rotationChanged) {
					FreezeEntityPosition(ped, false);
					SetEntityRotation(ped, config.pedRotation.x, config.pedRotation.y, config.pedRotation.z, 2, true);
					FreezeEntityPosition(ped, true);
					console.log(`[DEBUG] Arrow key rotation: x=${config.pedRotation.x}, z=${config.pedRotation.z}`);
				}

				// Only update position when adjustment keys are pressed (not every frame to avoid spinning)
				if (positionChanged) {
					SetEntityCoordsNoOffset(ped, config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, false, false, false);
					ClearPedTasks(ped);
					TaskStandStill(ped, -1);
					// Update camera to follow ped (in front)
					if (cam && camInfo) {
						const [playerX, playerY, playerZ] = GetEntityCoords(ped);
						const [fwdX, fwdY, fwdZ] = GetEntityForwardVector(ped);
						const fwdPos = {
							x: playerX + fwdX * 1.2,
							y: playerY + fwdY * 1.2,
							z: playerZ + fwdZ + camInfo.zPos,
						};
						SetCamCoord(cam, fwdPos.x, fwdPos.y, fwdPos.z);
						PointCamAtCoord(cam, playerX, playerY, playerZ + camInfo.zPos);
					}
				}
			}, 1);

			for (const type of Object.keys(config.cameraSettings)) {
				for (const stringComponent of Object.keys(config.cameraSettings[type])) {
					const categoryName = config.cameraSettings[type][stringComponent].name;
					const normalizedCategoryName = categoryName.toLowerCase().replace(/\s+/g, '_');

					// Check category filter - runtime argument takes priority over config
					const activeCategories = runtimeCategories || config.categories;
					if (activeCategories && activeCategories.length > 0) {
						if (!activeCategories.includes(normalizedCategoryName)) {
							if (config.debug) console.log(`[DEBUG] Skipping category: ${categoryName}`);
							continue;
						}
					}

					await ResetPedComponents();
					await Delay(150);
					const component = parseInt(stringComponent);
					const isProp = type === 'PROPS';

					// Check if we should use database items
					const dbItems = config.useDatabaseItems ? getDatabaseItems(component, isProp, pedType, activeCategories) : null;

					if (dbItems && dbItems.length > 0) {
						// Database-driven mode: only process items from database
						// Filter: skip 'both' items on female ped (already done on male)
						const itemsToProcess = dbItems.filter(item => !(item.gender === 'both' && pedType === 'female'));
						console.log(`[DB Mode] Processing ${itemsToProcess.length} items for ${categoryName} (${pedType})`);

						// Filter out already-existing files before processing
						const itemsFiltered = config.overwriteExistingImages ? itemsToProcess : itemsToProcess.filter(item => !existingFiles.has(item.name));
						const skippedCount = itemsToProcess.length - itemsFiltered.length;
						if (skippedCount > 0) {
							console.log(`[DB Mode] Skipping ${skippedCount} existing files for ${categoryName} (${pedType})`);
						}

						const failedItems = [];
						const startTime = Date.now();

						for (let i = 0; i < itemsFiltered.length; i++) {
							const item = itemsFiltered[i];
							try {
								SendNUIMessage({
									type: categoryName,
									value: i + 1,
									max: itemsFiltered.length,
								});

								let loadSuccess;
								if (isProp) {
									loadSuccess = await LoadPropVariation(ped, component, item.drawable_id, item.texture_id);
								} else {
									loadSuccess = await LoadComponentVariation(ped, component, item.drawable_id, item.texture_id);
								}

								if (loadSuccess === false) {
									console.warn(`[Greenscreener] Skipping ${item.name} (preload failed)`);
									failedItems.push(item.name);
									continue;
								}

								await takeScreenshotForComponent(pedType, type, component, item.drawable_id, item.texture_id, null, item.name, item.label);
							} catch (err) {
								console.error(`[Greenscreener] ERROR at item ${i} (${item.name}): ${err.message}`);
								failedItems.push(item.name);
								await ResetPedComponents();
								await Delay(300);
							}

							// Progress logging every 50 items
							if (i % 50 === 0 || i === itemsFiltered.length - 1) {
								const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
								const rate = elapsed > 0 ? (i / (elapsed)).toFixed(1) : '?';
								console.log(`[Greenscreener] ${categoryName} (${pedType}): ${i + 1}/${itemsFiltered.length} | ${elapsed}s | ${rate} items/s`);
							}

							// Batch pause every 100 items
							if (i > 0 && i % 100 === 0) {
								console.log(`[Greenscreener] Batch pause after ${i} items...`);
								await Delay(2000);
							}
						}

						// Summary
						const successCount = itemsFiltered.length - failedItems.length;
						console.log(`[Greenscreener] === ${categoryName} (${pedType}) DONE ===`);
						console.log(`  Success: ${successCount} | Failed: ${failedItems.length} | Skipped: ${skippedCount}`);
						if (failedItems.length > 0) {
							console.log(`  Failed items: ${failedItems.join(', ')}`);
						}
					} else if (!config.useDatabaseItems) {
						// Original mode: iterate all variations
						const failedNonDb = [];
						let nonDbCount = 0;
						const nonDbStartTime = Date.now();

						if (type === 'CLOTHING') {
							const drawableVariationCount = GetNumberOfPedDrawableVariations(ped, component);
							for (let drawable = 0; drawable < drawableVariationCount; drawable++) {
								const textureVariationCount = GetNumberOfPedTextureVariations(ped, component, drawable);
								SendNUIMessage({
									type: categoryName,
									value: drawable,
									max: drawableVariationCount,
								});
								if (config.includeTextures) {
									for (let texture = 0; texture < textureVariationCount; texture++) {
										try {
											const ok = await LoadComponentVariation(ped, component, drawable, texture);
											if (ok === false) { failedNonDb.push(`${drawable}_${texture}`); continue; }
											await takeScreenshotForComponent(pedType, type, component, drawable, texture);
										} catch (err) {
											console.error(`[Greenscreener] ERROR: Component ${component}, Drawable ${drawable}, Texture ${texture}: ${err.message}`);
											failedNonDb.push(`${drawable}_${texture}`);
											await ResetPedComponents();
											await Delay(300);
										}
										nonDbCount++;
									}
								} else {
									try {
										const ok = await LoadComponentVariation(ped, component, drawable);
										if (ok === false) { failedNonDb.push(`${drawable}`); continue; }
										await takeScreenshotForComponent(pedType, type, component, drawable);
									} catch (err) {
										console.error(`[Greenscreener] ERROR: Component ${component}, Drawable ${drawable}: ${err.message}`);
										failedNonDb.push(`${drawable}`);
										await ResetPedComponents();
										await Delay(300);
									}
									nonDbCount++;
								}

								// Progress logging
								if (drawable % 50 === 0 || drawable === drawableVariationCount - 1) {
									const elapsed = ((Date.now() - nonDbStartTime) / 1000).toFixed(0);
									console.log(`[Greenscreener] ${categoryName} (${pedType}): Drawable ${drawable + 1}/${drawableVariationCount} | ${elapsed}s`);
								}
								// Batch pause
								if (drawable > 0 && drawable % 100 === 0) {
									await Delay(2000);
								}
							}
						} else if (type === 'PROPS') {
							const propVariationCount = GetNumberOfPedPropDrawableVariations(ped, component);
							for (let prop = 0; prop < propVariationCount; prop++) {
								const textureVariationCount = GetNumberOfPedPropTextureVariations(ped, component, prop);
								SendNUIMessage({
									type: categoryName,
									value: prop,
									max: propVariationCount,
								});

								if (config.includeTextures) {
									for (let texture = 0; texture < textureVariationCount; texture++) {
										try {
											const ok = await LoadPropVariation(ped, component, prop, texture);
											if (ok === false) { failedNonDb.push(`${prop}_${texture}`); continue; }
											await takeScreenshotForComponent(pedType, type, component, prop, texture);
										} catch (err) {
											console.error(`[Greenscreener] ERROR: Prop ${component}, Drawable ${prop}, Texture ${texture}: ${err.message}`);
											failedNonDb.push(`${prop}_${texture}`);
											await ResetPedComponents();
											await Delay(300);
										}
										nonDbCount++;
									}
								} else {
									try {
										const ok = await LoadPropVariation(ped, component, prop);
										if (ok === false) { failedNonDb.push(`${prop}`); continue; }
										await takeScreenshotForComponent(pedType, type, component, prop);
									} catch (err) {
										console.error(`[Greenscreener] ERROR: Prop ${component}, Drawable ${prop}: ${err.message}`);
										failedNonDb.push(`${prop}`);
										await ResetPedComponents();
										await Delay(300);
									}
									nonDbCount++;
								}

								// Progress logging
								if (prop % 50 === 0 || prop === propVariationCount - 1) {
									const elapsed = ((Date.now() - nonDbStartTime) / 1000).toFixed(0);
									console.log(`[Greenscreener] ${categoryName} (${pedType}): Prop ${prop + 1}/${propVariationCount} | ${elapsed}s`);
								}
								// Batch pause
								if (prop > 0 && prop % 100 === 0) {
									await Delay(2000);
								}
							}
						}

						// Summary
						console.log(`[Greenscreener] === ${categoryName} (${pedType}) DONE ===`);
						console.log(`  Processed: ${nonDbCount} | Failed: ${failedNonDb.length}`);
						if (failedNonDb.length > 0) {
							console.log(`  Failed items: ${failedNonDb.join(', ')}`);
						}
					} else {
						console.log(`[DB Mode] No items found for ${categoryName} (${pedType}), skipping`);
					}
				}
			}
			SetModelAsNoLongerNeeded(modelHash);
			SetPlayerControl(playerId, true);
			FreezeEntityPosition(ped, false);
			clearInterval(interval);
		}
	}
	SetPedOnGround();
	startWeatherResource();
	deleteGreenScreen();
	DisplayHud(true);
	DisplayRadar(true);
	SendNUIMessage({
		end: true,
	});
	DestroyAllCams(true);
	DestroyCam(cam, true);
	RenderScriptCams(false, false, 0, true, false, 0);
	camInfo = null;
	cam = null;
	lastAppliedRotationZ = null;
});

RegisterCommand('customscreenshot', async (source, args) => {

	const type = args[2].toUpperCase();
	const component = parseInt(args[0]);
	let drawable = args[1].toLowerCase() == 'all' ? args[1].toLowerCase() : parseInt(args[1]);
	let prop = args[1].toLowerCase() == 'all' ? args[1].toLowerCase() : parseInt(args[1]);
	const gender = args[3].toLowerCase();
	let cameraSettings;


	let modelHashes;

	if (gender == 'male') {
		modelHashes = [GetHashKey('mp_m_freemode_01')];
	} else if (gender == 'female') {
		modelHashes = [GetHashKey('mp_f_freemode_01')];
	} else {
		modelHashes = [GetHashKey('mp_m_freemode_01'), GetHashKey('mp_f_freemode_01')];
	}

	if (args[4] != null) {
		let cameraSettings = ''
		for (let i = 4; i < args.length; i++) {
			cameraSettings += args[i] + ' ';
		}

		cameraSettings = JSON.parse(cameraSettings);
	}


	if (!stopWeatherResource()) return;

	DisableIdleCamera(true);
	DisplayHud(false);
	DisplayRadar(false);
	// Hide chat at start
	emit('chat:clear');
	emit('chat:hide', true);
	SetTextChatEnabled(false);
	await spawnGreenScreen();

	await Delay(100);

	for (const modelHash of modelHashes) {
		if (IsModelValid(modelHash)) {
			if (!HasModelLoaded(modelHash)) {
				RequestModel(modelHash);
				while (!HasModelLoaded(modelHash)) {
					await Delay(100);
				}
			}

			SetPlayerModel(playerId, modelHash);
			await Delay(150);
			SetModelAsNoLongerNeeded(modelHash);

			await Delay(150);

			ped = PlayerPedId();

			const pedType = modelHash === GetHashKey('mp_m_freemode_01') ? 'male' : 'female';
			// Initial ped setup - BEFORE starting the interval
			SetEntityCoordsNoOffset(ped, config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, false, false, false);
			FreezeEntityPosition(ped, true);
			// Disable idle animations
			ClearPedTasks(ped);
			ClearPedTasksImmediately(ped);
			SetPedCanPlayAmbientAnims(ped, false);
			SetPedCanPlayGestureAnims(ped, false);
			SetPedCanPlayVisemeAnims(ped, false, false);
			SetPedConfigFlag(ped, 292, true); // Disable ambient clips
			TaskStandStill(ped, -1);
			SetPlayerControl(playerId, false, 0);
			await Delay(100);

			interval = setInterval(() => {
				HideHudAndRadarThisFrame();
				for (let i = 1; i <= 22; i++) {
					HideHudComponentThisFrame(i);
				}
				hideTxAdminWarning();

				// Disable controls so we can detect them
				DisableControlAction(0, 32, true); // W
				DisableControlAction(0, 33, true); // S
				DisableControlAction(0, 34, true); // A
				DisableControlAction(0, 35, true); // D
				DisableControlAction(0, 44, true); // Q
				DisableControlAction(0, 38, true); // E
				DisableControlAction(0, 172, true); // Arrow Up
				DisableControlAction(0, 173, true); // Arrow Down
				DisableControlAction(0, 174, true); // Arrow Left
				DisableControlAction(0, 175, true); // Arrow Right
				DisableControlAction(0, 0, true); // V

				// Adjustment controls - WASD for ped position, Q/E for Z, Arrows for rotation
				let positionChanged = false;
				let rotationChanged = false;
				if (IsDisabledControlJustPressed(0, 32)) { config.pedPosition.y += 0.5; positionChanged = true; } // W - forward (Y+)
				if (IsDisabledControlJustPressed(0, 33)) { config.pedPosition.y -= 0.5; positionChanged = true; } // S - back (Y-)
				if (IsDisabledControlJustPressed(0, 34)) { config.pedPosition.x -= 0.5; positionChanged = true; } // A - left (X-)
				if (IsDisabledControlJustPressed(0, 35)) { config.pedPosition.x += 0.5; positionChanged = true; } // D - right (X+)
				if (IsDisabledControlJustPressed(0, 44)) { config.pedPosition.z -= 0.5; positionChanged = true; } // Q - down (Z-)
				if (IsDisabledControlJustPressed(0, 38)) { config.pedPosition.z += 0.5; positionChanged = true; } // E - up (Z+)
				if (IsDisabledControlJustPressed(0, 172)) { config.pedRotation.x += 5; rotationChanged = true; } // Arrow Up - tilt up
				if (IsDisabledControlJustPressed(0, 173)) { config.pedRotation.x -= 5; rotationChanged = true; } // Arrow Down - tilt down
				if (IsDisabledControlJustPressed(0, 174)) { config.pedRotation.z += 5; rotationChanged = true; } // Arrow Left - rotate left
				if (IsDisabledControlJustPressed(0, 175)) { config.pedRotation.z -= 5; rotationChanged = true; } // Arrow Right - rotate right
				if (IsDisabledControlJustPressed(0, 0)) emitNet('printPedSettings', config.pedPosition, config.pedRotation); // V - print

				// Apply rotation when changed - only rotate ped, don't move camera
				if (rotationChanged) {
					FreezeEntityPosition(ped, false);
					SetEntityRotation(ped, config.pedRotation.x, config.pedRotation.y, config.pedRotation.z, 2, true);
					FreezeEntityPosition(ped, true);
					console.log(`[DEBUG] Arrow key rotation: x=${config.pedRotation.x}, z=${config.pedRotation.z}`);
				}

				// Only update position when adjustment keys are pressed (not every frame to avoid spinning)
				if (positionChanged) {
					SetEntityCoordsNoOffset(ped, config.pedPosition.x, config.pedPosition.y, config.pedPosition.z, false, false, false);
					ClearPedTasks(ped);
					TaskStandStill(ped, -1);
					// Update camera to follow ped (in front)
					if (cam && camInfo) {
						const [playerX, playerY, playerZ] = GetEntityCoords(ped);
						const [fwdX, fwdY, fwdZ] = GetEntityForwardVector(ped);
						const fwdPos = {
							x: playerX + fwdX * 1.2,
							y: playerY + fwdY * 1.2,
							z: playerZ + fwdZ + camInfo.zPos,
						};
						SetCamCoord(cam, fwdPos.x, fwdPos.y, fwdPos.z);
						PointCamAtCoord(cam, playerX, playerY, playerZ + camInfo.zPos);
					}
				}
			}, 1);

			ResetPedComponents();
			await Delay(150);

			if (drawable == 'all') {
				SendNUIMessage({
					start: true,
				});
				if (type === 'CLOTHING') {
					const drawableVariationCount = GetNumberOfPedDrawableVariations(ped, component);
					for (drawable = 0; drawable < drawableVariationCount; drawable++) {
						const textureVariationCount = GetNumberOfPedTextureVariations(ped, component, drawable);
						SendNUIMessage({
							type: config.cameraSettings[type][component].name,
							value: drawable,
							max: drawableVariationCount,
						});
						if (config.includeTextures) {
							for (let texture = 0; texture < textureVariationCount; texture++) {
								await LoadComponentVariation(ped, component, drawable, texture);
								await takeScreenshotForComponent(pedType, type, component, drawable, texture, cameraSettings);
							}
						} else {
							await LoadComponentVariation(ped, component, drawable);
							await takeScreenshotForComponent(pedType, type, component, drawable, null, cameraSettings);
						}
					}
				} else if (type === 'PROPS') {
					const propVariationCount = GetNumberOfPedPropDrawableVariations(ped, component);
					for (prop = 0; prop < propVariationCount; prop++) {
						const textureVariationCount = GetNumberOfPedPropTextureVariations(ped, component, prop);
						SendNUIMessage({
							type: config.cameraSettings[type][component].name,
							value: prop,
							max: propVariationCount,
						});

						if (config.includeTextures) {
							for (let texture = 0; texture < textureVariationCount; texture++) {
								await LoadPropVariation(ped, component, prop, texture);
								await takeScreenshotForComponent(pedType, type, component, prop, texture, cameraSettings);
							}
						} else {
							await LoadPropVariation(ped, component, prop);
							await takeScreenshotForComponent(pedType, type, component, prop, null, cameraSettings);
						}
					}
				}
			} else if (!isNaN(drawable)) {
				if (type === 'CLOTHING') {
					const textureVariationCount = GetNumberOfPedTextureVariations(ped, component, drawable);

					if (config.includeTextures) {
						for (let texture = 0; texture < textureVariationCount; texture++) {
							await LoadComponentVariation(ped, component, drawable, texture);
							await takeScreenshotForComponent(pedType, type, component, drawable, texture, cameraSettings);
						}
					} else {
						await LoadComponentVariation(ped, component, drawable);
						await takeScreenshotForComponent(pedType, type, component, drawable, null, cameraSettings);
					}
				} else if (type === 'PROPS') {
					const textureVariationCount = GetNumberOfPedPropTextureVariations(ped, component, prop);

					if (config.includeTextures) {
						for (let texture = 0; texture < textureVariationCount; texture++) {
							await LoadPropVariation(ped, component, prop, texture);
							await takeScreenshotForComponent(pedType, type, component, prop, texture, cameraSettings);
						}
					} else {
						await LoadPropVariation(ped, component, prop);
						await takeScreenshotForComponent(pedType, type, component, prop, null, cameraSettings);
					}
				}
			}
			SetPlayerControl(playerId, true);
			FreezeEntityPosition(ped, false);
			clearInterval(interval);
		}
	}
	SetPedOnGround();
	startWeatherResource();
	deleteGreenScreen();
	DisplayHud(true);
	DisplayRadar(true);
	SendNUIMessage({
		end: true,
	});
	DestroyAllCams(true);
	DestroyCam(cam, true);
	RenderScriptCams(false, false, 0, true, false, 0);
	camInfo = null;
	cam = null;
	lastAppliedRotationZ = null;
});

RegisterCommand('screenshotobject', async (source, args) => {
	let modelHash = isNaN(Number(args[0])) ? GetHashKey(args[0]) : Number(args[0]);
	const ped = GetPlayerPed(-1);

	if (IsWeaponValid(modelHash)) {
		modelHash = GetWeapontypeModel(modelHash);
	}

	if (!stopWeatherResource()) return;

	DisableIdleCamera(true);


	await Delay(100);

	if (IsModelValid(modelHash)) {
		if (!HasModelLoaded(modelHash)) {
			RequestModel(modelHash);
			while (!HasModelLoaded(modelHash)) {
				await Delay(100);
			}
		}
	} else {
		console.log('ERROR: Invalid object model');
		return;
	}


	SetEntityCoords(ped, config.greenScreenHiddenSpot.x, config.greenScreenHiddenSpot.y, config.greenScreenHiddenSpot.z, false, false, false);

	SetPlayerControl(playerId, false);

	if (config.debug) console.log(`DEBUG: Spawning Object ${modelHash}`);

	const object = CreateObjectNoOffset(modelHash, config.greenScreenObjectPosition.x, config.greenScreenObjectPosition.y, config.greenScreenObjectPosition.z, false, true, true);

	SetEntityRotation(object, config.pedRotation.x, config.pedRotation.y, config.pedRotation.z, 0, false);

	FreezeEntityPosition(object, true);

	await Delay(50);

	await takeScreenshotForObject(object, modelHash);


	DeleteEntity(object);
	SetPlayerControl(playerId, true);
	SetModelAsNoLongerNeeded(modelHash);
	startWeatherResource();
	DestroyAllCams(true);
	DestroyCam(cam, true);
	RenderScriptCams(false, false, 0, true, false, 0);
	cam = null;
});

RegisterCommand('screenshotvehicle', async (source, args) => {
	const vehicles = (config.useQBVehicles && QBCore != null) ? Object.keys(QBCore.Shared.Vehicles) : GetAllVehicleModels();
	const ped = PlayerPedId();
	const type = args[0].toLowerCase();
	const primarycolor = args[1] ? parseInt(args[1]) : null;
	const secondarycolor = args[2] ? parseInt(args[2]) : null;

	if (!stopWeatherResource()) return;


	DisableIdleCamera(true);
	SetEntityCoords(ped, config.greenScreenHiddenSpot.x, config.greenScreenHiddenSpot.y, config.greenScreenHiddenSpot.z, false, false, false);
	SetPlayerControl(playerId, false);

	ClearAreaOfVehicles(config.greenScreenObjectPosition.x, config.greenScreenObjectPosition.y, config.greenScreenObjectPosition.z, 10, false, false, false, false, false);

	await Delay(100);

	if (type === 'all') {
		SendNUIMessage({
			start: true,
		});
		for (const vehicleModel of vehicles) {
			const vehicleHash = GetHashKey(vehicleModel);
			if (!IsModelValid(vehicleHash)) continue;


			const vehicleClass = GetVehicleClassFromName(vehicleHash);

			if (!config.includedVehicleClasses[vehicleClass]) {
				SetModelAsNoLongerNeeded(vehicleHash);
				continue;
			}

			SendNUIMessage({
				type: vehicleModel,
				value: vehicles.indexOf(vehicleModel) + 1,
				max: vehicles.length + 1
			});

			const vehicle = await createGreenScreenVehicle(vehicleHash, vehicleModel);

			if (vehicle === 0 || vehicle === null) {
				SetModelAsNoLongerNeeded(vehicleHash);
				console.log(`ERROR: Could not spawn vehicle. Broken Vehicle: ${vehicleModel}`);
				continue;
			}

			SetEntityRotation(vehicle, config.greenScreenVehicleRotation.x, config.greenScreenVehicleRotation.y, config.greenScreenVehicleRotation.z, 0, false);

			FreezeEntityPosition(vehicle, true);

			SetVehicleWindowTint(vehicle, 1);

			if (primarycolor) SetVehicleColours(vehicle, primarycolor, secondarycolor || primarycolor);

			await Delay(50);

			await takeScreenshotForVehicle(vehicle, vehicleHash, vehicleModel);

			DeleteEntity(vehicle);
			SetModelAsNoLongerNeeded(vehicleHash);
		}
		SendNUIMessage({
			end: true,
		});
	} else {
		const vehicleModel = type;
		const vehicleHash = GetHashKey(vehicleModel);
		if (IsModelValid(vehicleHash)) {



			SendNUIMessage({
				type: vehicleModel,
				value: vehicles.indexOf(vehicleModel) + 1,
				max: vehicles.length + 1
			});

			const vehicle = await createGreenScreenVehicle(vehicleHash, vehicleModel);

			if (vehicle === 0 || vehicle === null) {
				SetModelAsNoLongerNeeded(vehicleHash);
				console.log(`ERROR: Could not spawn vehicle. Broken Vehicle: ${vehicleModel}`);
				return;
			}

			SetEntityRotation(vehicle, config.greenScreenVehicleRotation.x, config.greenScreenVehicleRotation.y, config.greenScreenVehicleRotation.z, 0, false);

			FreezeEntityPosition(vehicle, true);

			SetVehicleWindowTint(vehicle, 1);

			if (primarycolor) SetVehicleColours(vehicle, primarycolor, secondarycolor || primarycolor);

			await Delay(50);

			await takeScreenshotForVehicle(vehicle, vehicleHash, vehicleModel);

			DeleteEntity(vehicle);
			SetModelAsNoLongerNeeded(vehicleHash);
		} else {
			console.log('ERROR: Invalid vehicle model');
		}
	}
	SetPlayerControl(playerId, true);
	startWeatherResource();
	DestroyAllCams(true);
	DestroyCam(cam, true);
	RenderScriptCams(false, false, 0, true, false, 0);
	cam = null;
});



setImmediate(() => {
	emit('chat:addSuggestions', [
		{
			name: '/screenshot',
			help: 'generate clothing screenshots',
		},
		{
			name: '/customscreenshot',
			help: 'generate custom cloting screenshots',
			params: [
				{name:"component", help:"The clothing component to take a screenshot of"},
				{name:"drawable/all", help:"The drawable variation to take a screenshot of"},
				{name:"props/clothing", help:"PROPS or CLOTHING"},
				{name:"male/female/both", help:"The gender to take a screenshot of"},
				{name:"camera settings", help:"The camera settings to use for the screenshot (optional)"},
			]
		},
		{
			name: '/screenshotobject',
			help: 'generate object screenshots',
			params: [
				{name:"object", help:"The object hash to take a screenshot of"},
			]
		},
		{
			name: '/screenshotvehicle',
			help: 'generate vehicle screenshots',
			params: [
				{name:"model/all", help:"The vehicle model or 'all' to take a screenshot of all vehicles"},
				{name:"primarycolor", help:"The primary vehicle color to take a screenshot of (optional) See: https://wiki.rage.mp/index.php?title=Vehicle_Colors"},
				{name:"secondarycolor", help:"The secondary vehicle color to take a screenshot of (optional) See: https://wiki.rage.mp/index.php?title=Vehicle_Colors"},
			]
		}
	])
  });

on('onResourceStop', (resName) => {
	if (GetCurrentResourceName() != resName) return;

	startWeatherResource();
	deleteGreenScreen();
	DisplayHud(true);
	DisplayRadar(true);
	clearInterval(interval);
	SetPlayerControl(playerId, true);
	FreezeEntityPosition(ped, false);
});
