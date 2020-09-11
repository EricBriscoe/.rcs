" https://github.com/VundleVim/Vundle.vim#about
"  git clone https://github.com/VundleVim/Vundle.vim.git ~/.vim/bundle/Vundle.vim
set nocompatible
filetype off

" set the runtime path to include Vundle and initialize
set rtp+=~/.vim/bundle/Vundle.vim
call vundle#begin()
" alternatively, pass a path where Vundle should install plugins
"call vundle#begin('~/some/path/here')

" let Vundle manage Vundle, required
Plugin 'VundleVim/Vundle.vim'
Plugin 'valloric/youcompleteme'
Plugin 'kien/rainbow_parentheses.vim'
Plugin 'morhetz/gruvbox'
Plugin 'psf/black'
Plugin 'nathanaelkane/vim-indent-guides'
Plugin 'sheerun/vim-polyglot'
Plugin 'tpope/vim-fugitive'
Plugin 'airblade/vim-gitgutter'

" All of your Plugins must be added before the following line
call vundle#end()            " required
filetype plugin indent on    " required
" To ignore plugin indent changes, instead use:
"filetype plugin on
"
" Brief help
" :PluginList       - lists configured plugins
" :PluginInstall    - installs plugins; append `!` to update or just :PluginUpdate
" :PluginSearch foo - searches for foo; append `!` to refresh local cache
" :PluginClean      - confirms removal of unused plugins; append `!` to auto-approve removal
"
" see :h vundle for more details or wiki for FAQ
" Put your non-Plugin stuff after this line

set nu

au VimEnter * RainbowParenthesesToggle
au Syntax * RainbowParenthesesLoadRound
au Syntax * RainbowParenthesesLoadSquare
au Syntax * RainbowParenthesesLoadBraces

let g:gruvbox_invert_selection = 0
let g:gruvbox_contrast_dark = 'soft'
let g:indent_guides_enable_on_vim_startup = 1
let g:gruvbox_number_column = 'bg1'
set termguicolors
colorscheme gruvbox

let g:black_skip_string_normalization = 0
