fx_version 'cerulean'
game 'gta5'

author 'Ben'
description 'fivem-greenscreener'
version '2.0.0'

this_is_a_map 'yes'

ui_page 'html/index.html'

files {
    'config.json',
    'clothing_items.json',
    'html/*'
}

client_script 'client.js'

server_script 'server.js'

data_file 'DLC_ITYP_REQUEST' 'stream/jim_g_green_screen_v1.ytyp'

dependencies {
	'screenshot-basic',
    'yarn'
}
