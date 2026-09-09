-- Shell, Swift, and tree-sitter odds and ends that no LazyVim extra covers.
return {
  {
    "stevearc/conform.nvim",
    optional = true,
    opts = {
      formatters = {
        -- conform already passes -i <shiftwidth>; add indented case bodies.
        shfmt = { prepend_args = { "-ci" } },
      },
    },
  },
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Swift through Xcode's toolchain; Mason does not package it.
        sourcekit = {
          mason = false,
          enabled = vim.fn.executable("sourcekit-lsp") == 1,
          filetypes = { "swift" },
        },
      },
    },
  },
  {
    "nvim-treesitter/nvim-treesitter",
    opts = { ensure_installed = { "swift" } },
  },
}
