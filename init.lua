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
cmd 'set ignorecase' -- This'll only be case sensitive matching
cmd 'set smartcase'  -- when capitals are in the search
cmd 'let g:python3_host_prog = "~/.rcs/nvim/bin/python"'
cmd 'set tabstop=2'
cmd 'set shiftwidth=2'
cmd 'set expandtab'
cmd 'autocmd BufNewFile,BufRead *.sqli set syntax=sql'
cmd 'autocmd FileType yaml setlocal ts=2 sts=2 sw=2 expandtab'
cmd 'autocmd FileType sql setlocal ts=2 sts=2 sw=2 expandtab'
cmd 'set cursorline'
cmd 'set colorcolumn=80,120'
cmd 'highlight ColorColumn ctermbg=lightgrey'
-- NVIM SETTINGS --


-- PLUGINS --
require "paq"{
  'savq/paq-nvim';
  {'junegunn/fzf', run=fn['fzf#install']};
  'junegunn/fzf.vim';
  'Shougo/deoplete.nvim';
  --{'tbodt/deoplete-tabnine', run='./install.sh'};
  'deoplete-plugins/deoplete-jedi';
  --'github/copilot.vim';
  'ojroques/nvim-lspfuzzy';
  'morhetz/gruvbox';
  'tmhedberg/SimpylFold';
  'psf/black';
  'nathanaelkane/vim-indent-guides';
  'tpope/vim-fugitive';
  'vim-airline/vim-airline';
  'liuchengxu/vim-which-key';
  'preservim/nerdcommenter';
  'airblade/vim-gitgutter';
  'voldikss/vim-floaterm';
  'Vimjas/vim-python-pep8-indent';
  'ekalinin/Dockerfile.vim';
}
-- PLUGINS --

-- AIRLINE --
-- AIRLINE --

-- DEOPLETE --
g['deoplete#enable_at_startup'] = 1
-- DEOPLETE --

-- GRUVBOX --
g['gruvbox_invert_selection'] = 0
g['gruvbox_contrast_dark'] = 'soft'
g['indent_guides_enable_on_vim_startup'] = 1
cmd 'set termguicolors'
cmd 'colorscheme gruvbox'
-- GRUVBOX --

-- NERDCommenter --
cmd 'let g:NERDCreateDefaultMappings = 1'
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
map('n', '<leader>/', ':call nerdcommenter#Comment(",", "toggle")<CR>')
-- Kill terminal with escape
map('t', '<Esc>', '<C-\\><C-n><cmd>FloatermKill<CR>')
-- KEYBINDS --
