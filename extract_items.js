// Run this script with: node extract_items.js <path-to-sql-file>
// It will parse the SQL file and generate clothing_items.json
//
// The SQL file must contain INSERT statements for a `clothing_catalog_labels` table.
// Example: node extract_items.js ./my_database_dump.sql

const fs = require('fs');
const path = require('path');

const sqlFilePath = process.argv[2];
if (!sqlFilePath) {
	console.error('Usage: node extract_items.js <path-to-sql-file>');
	console.error('Example: node extract_items.js ./database_dump.sql');
	process.exit(1);
}

if (!fs.existsSync(sqlFilePath)) {
	console.error(`File not found: ${sqlFilePath}`);
	process.exit(1);
}

const outputPath = path.join(__dirname, 'clothing_items.json');

// Type to category mapping
const typeToCategory = {
	'clothing_mask': { category: 'masks', component_id: 1, is_prop: false },
	'clothing_top': { category: 'tops', component_id: 11, is_prop: false },
	'clothing_pants': { category: 'legs', component_id: 4, is_prop: false },
	'clothing_shoes': { category: 'shoes', component_id: 6, is_prop: false },
	'clothing_torso': { category: 'torsos', component_id: 3, is_prop: false },
	'clothing_undershirt': { category: 'undershirts', component_id: 8, is_prop: false },
	'clothing_bag': { category: 'bags', component_id: 5, is_prop: false },
	'clothing_accessory': { category: 'accessories', component_id: 7, is_prop: false },
	'clothing_vest': { category: 'body_armors', component_id: 9, is_prop: false },
	'clothing_hat': { category: 'hats', component_id: 0, is_prop: true },
	'clothing_glasses': { category: 'glasses', component_id: 1, is_prop: true },
	'clothing_ears': { category: 'ears', component_id: 2, is_prop: true },
	'clothing_watch': { category: 'watches', component_id: 6, is_prop: true },
	'clothing_bracelet': { category: 'bracelets', component_id: 7, is_prop: true },
	// Skip these - not used for screenshots
	'clothing_decal': null,
	'clothing_hair': null,
};

console.log('Reading SQL file...');
const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

// Find the clothing_catalog_labels INSERT statements
const items = [];
const insertRegex = /INSERT INTO `clothing_catalog_labels`[^;]+;/gs;
const valueRegex = /\((\d+),\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*([01]),\s*'([^']+)',\s*'([^']+)',\s*(\d+|NULL),\s*(\d+|NULL),\s*(\d+|NULL),\s*(\d+|NULL)\)/g;

console.log('Parsing INSERT statements...');

let match;
while ((match = insertRegex.exec(sqlContent)) !== null) {
	const insertStatement = match[0];

	// Only process clothing_catalog_labels
	if (!insertStatement.includes('clothing_catalog_labels')) continue;

	let valueMatch;
	while ((valueMatch = valueRegex.exec(insertStatement)) !== null) {
		const [
			_full,
			id,
			name,
			label,
			type,
			gender,
			description,
			price_buy,
			price_sell,
			weight,
			component_id,
			drawable_id,
			texture_id,
			palette_id,
			is_prop,
			rarity,
			created_at,
			male_drawable_id,
			male_texture_id,
			female_drawable_id,
			female_texture_id
		] = valueMatch;

		const typeInfo = typeToCategory[type];
		if (!typeInfo) continue; // Skip unknown/unused types

		items.push({
			name: name,
			type: type,
			category: typeInfo.category,
			gender: gender,
			component_id: parseInt(component_id),
			drawable_id: parseInt(drawable_id),
			texture_id: parseInt(texture_id),
			is_prop: is_prop === '1',
			male_drawable_id: male_drawable_id === 'NULL' ? null : parseInt(male_drawable_id),
			male_texture_id: male_texture_id === 'NULL' ? null : parseInt(male_texture_id),
			female_drawable_id: female_drawable_id === 'NULL' ? null : parseInt(female_drawable_id),
			female_texture_id: female_texture_id === 'NULL' ? null : parseInt(female_texture_id),
		});
	}
}

console.log(`Found ${items.length} items`);

// Group by category for stats
const categoryStats = {};
for (const item of items) {
	categoryStats[item.category] = (categoryStats[item.category] || 0) + 1;
}
console.log('Items per category:');
for (const [cat, count] of Object.entries(categoryStats).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${cat}: ${count}`);
}

// Save to JSON
const output = {
	generated_at: new Date().toISOString(),
	total_items: items.length,
	categories: Object.keys(categoryStats),
	items: items
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\nSaved to ${outputPath}`);
