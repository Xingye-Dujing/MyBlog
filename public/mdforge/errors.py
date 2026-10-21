class MdForgeError(Exception):
    """Base error carrying an optional source line."""

    def __init__(self, message: str, line: int = 0):
        super().__init__(message)
        self.message = message
        self.line = line


class ValidationError(MdForgeError):
    pass


class TemplateError(MdForgeError):
    pass


class RenderError(MdForgeError):
    pass


class CompileError(MdForgeError):
    def __init__(self, message: str, log: str = "", line: int = 0):
        super().__init__(message, line)
        self.log = log
