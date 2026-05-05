vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.signcolumn = "yes"
vim.opt.cursorline = true
vim.opt.termguicolors = true
vim.opt.updatetime = 250
vim.opt.timeoutlen = 400
vim.opt.splitright = true
vim.opt.splitbelow = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.undofile = true
vim.opt.expandtab = true
vim.opt.shiftwidth = 4
vim.opt.tabstop = 4
vim.opt.softtabstop = 4
vim.opt.completeopt = { "menu", "menuone", "noinsert", "fuzzy", "popup" }

vim.diagnostic.config({
  virtual_text = { source = "if_many", spacing = 2 },
  severity_sort = true,
  float = { border = "rounded", source = true },
})

vim.keymap.set("n", "[t", "gT", { desc = "Previous tab" })
vim.keymap.set("n", "]t", "gt", { desc = "Next tab" })
