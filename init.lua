-- HELPERS --
local cmd = vim.cmd  -- to execute Vim commands e.g. cmd('pwd')
local fn = vim.fn    -- to call Vim functions e.g. fn.bufnr()
local g = vim.g      -- a table to access global variables
local scopes = {o = vim.o, b = vim.bo, w = vim.wo}

local function opt(scope, key, value)
	scopes[scope][key] = value
	if scope ~= 'o' then scopes['o'][key] = value end
end

local function map(mode, lhs, rhs, opts)
	local options = {noremap = true}
	if opts then options = vim.tbl_extend('force', options, opts) end
	vim.api.nvim_set_keymap(mode, lhs, rhs, options)
end
-- HELPERS --

-- NVIM SETTINGS --
cmd 'set mouse=a'
cmd 'set nowrap'
cmd 'set foldmethod=syntax'
cmd 'filetype plugin on'
cmd 'set nu'
cmd 'filetype plugin on'
cmd 'set ignorecase' -- This'll only be case sensitive matching
cmd 'set smartcase'  -- when capitals are in the search
-- NVIM SETTINGS --


-- PLUGINS --
vim.cmd 'packadd paq-nvim' -- loads the package manager
local paq = require('paq-nvim').paq
paq{'savq/paq-nvim', opt=true}
paq 'shougo/deoplete-lsp'
paq {'shougo/deoplete.nvim', run=fn['remote#host#UpdateRemotePlugins']}
paq 'nvim-treesitter/nvim-treesitter'
paq 'neovim/nvim-lspconfig'
paq {'junegunn/fzf', run=fn['fzf#install']}
paq 'junegunn/fzf.vim'
paq 'ojroques/nvim-lspfuzzy'
paq 'morhetz/gruvbox'
paq 'tmhedberg/SimpylFold'
paq 'psf/black'
paq 'nathanaelkane/vim-indent-guides'
paq 'tpope/vim-fugitive'
paq 'vim-airline/vim-airline'
paq 'liuchengxu/vim-which-key'
paq 'preservim/nerdcommenter'
paq 'airblade/vim-gitgutter'
paq 'voldikss/vim-floaterm'
-- PLUGINS --


-- GRUVBOX --
g['gruvbox_invert_selection'] = 0
g['gruvbox_contrast_dark'] = 'soft'
g['indent_guides_enable_on_vim_startup'] = 1
cmd 'set termguicolors'
cmd 'colorscheme gruvbox'
-- GRUVBOX --

-- DEOPLETE --
g['deoplete#enable_at_startup'] = 1
-- DEOPLETE --

-- LSP --
local lsp = require 'lspconfig'
lsp.ccls.setup {}
lsp.pyls.setup {
	root_dir = lsp.util.root_pattern('.git', fn.getcwd()),
	settings = {
		pyls = {
			configurationSources = {'flake8'},
			plugins = {
				flake8 = {enabled = true},
				pycodestyle = {enabled = false},
				pylint = {enabled = false},
				pydocstyle = {enabled = false},
				pyflakes = {enabled = false},
				mccabe = {enabled = false},
				yapf = {enabled = false},
			}
		}
	}
}
-- LSP --

-- LSP FUZZY --
local lspfuzzy = require 'lspfuzzy'
lspfuzzy.setup {}
-- LSP FUZZY --

-- TREESITTER --
local ts = require 'nvim-treesitter.configs'
ts.setup {ensure_installed = 'python', highlight = {enabled = true}}
-- TREESITTER --

-- NERDCommenter --
cmd 'let g:NERDCreateDefaultMappings = 0'
-- NERDCommenter --


-- KEYBINDS --
g.mapleader = ' '
-- autocomplete
map('i', '<S-Tab>', 'pumvisible() ? "\\<C-p>" : "\\<Tab>"', {expr = true})
map('i', '<Tab>', 'pumvisible() ? "\\<C-n>" : "\\<Tab>"', {expr = true})
-- f keys
map('n', '<F9>', ':tabp<CR>')
map('n', '<F10>', ':tabn<CR>')
map('n', '<F12>', '<cmd>FloatermToggle<CR>')
map('i', '<F12>', '<cmd>FloatermToggle<CR>')
map('t', '<F12>', '<C-\\><C-n><cmd>FloatermToggle<CR>')
-- code navigation
map('n', '<leader>d', '<cmd>lua vim.lsp.buf.definition()<CR>')
-- git
map('n', '<leader>gb', 'Git blame<CR>')
-- Which Key
map('n', '<leader>', ':WhichKey " "<CR>', { silent = true })
-- FZF
map('n', '<C-t>', ':Files<CR>')
-- NERDCommenter
map('n', '<leader>/', ':call NERDComment(",", "toggle")<CR>')
-- Close terminal with escape
map('t', '<Esc>', '<C-\\><C-n><cmd>FloatermToggle<CR>')
-- KEYBINDS --
